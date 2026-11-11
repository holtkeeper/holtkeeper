import { type Principal, can } from '@holtkeeper/access'
import type {
  AgentTaskGroupDetail,
  AgentTaskGroupList,
  AgentTaskGroupView,
  AgentTaskView,
  WriteTasksStatus,
} from '@holtkeeper/api'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import { type Env, type ServerDeps, limitParam, principalOf, readBody } from '../context.ts'
import {
  TaskError,
  type TaskDeps,
  approveTaskGroup,
  canSeeGroup,
  cancelTaskGroup,
  createTaskGroup,
  decideRepoRequest,
  groupView,
  refreshTaskGroup,
  retryTask,
  taskGroupRequestSchema,
} from '../tasks.ts'
import { tasksWriteSettings, weeklyWriteSpend, writePoolStatus } from '../write-tasks.ts'
import { peopleOf } from './avatars.ts'

const decisionSchema = z.object({ repo: z.string().min(3), approve: z.boolean() })

const GLOBAL = { kind: 'global' } as const

const peopleIds = (groups: readonly AgentTaskGroupView[]) =>
  groups.flatMap((group) => [
    group.proposedBy,
    ...(group.approvedBy ? [group.approvedBy] : []),
    ...(group.cancelledBy ? [group.cancelledBy] : []),
    ...group.tasks.map((task) => task.requester),
    ...(group.requests ?? []).flatMap((request) => (request.decidedBy ? [request.decidedBy] : [])),
  ])

const sourceTypes = ['chat', 'dependency-upgrade', 'propagate', 'mcp', 'api'] as const

const guarded = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work()
  } catch (error) {
    if (error instanceof TaskError)
      throw new HTTPException(error.status, { message: error.message })
    throw error
  }
}

/**
 * Agent task routes: `GET /api/task-groups` (groups with a target the caller may see),
 * `GET /api/task-groups/:id` (reads open merge requests' state and CI from the forge at most once a
 * minute), `POST /api/task-groups` (propose; `run: true` approves at once), `POST
 * /api/task-groups/:id/approve` and `/cancel`, `POST /api/task-groups/:id/requests` (decide a
 * repository a task asked for), `GET /api/tasks/:id`, `POST /api/tasks/:id/retry` and `/cancel`
 * (one task), and `GET /api/write-tasks` (the switch, caps and write pool status). Refusals of
 * the task service answer with its status.
 */
export function taskRoutes(deps: ServerDeps) {
  const app = new Hono<Env>()
  const taskDeps: TaskDeps = { ...deps, readOnly: deps.readOnly ?? (async () => false) }

  const visibleGroup = async (principal: Principal, id: string) => {
    const group = await deps.store.tasks.getGroup(id)
    if (!group || !canSeeGroup(deps, principal, group))
      throw new HTTPException(404, { message: 'no such task group' })
    return group
  }

  app.get('/task-groups', async (c) => {
    const principal = principalOf(c)
    const sourceType = sourceTypes.find((type) => type === c.req.query('source'))
    const repo = c.req.query('repo')
    const groups = await deps.store.tasks.listGroups({
      ...(sourceType ? { sourceType } : {}),
      ...(repo ? { repos: [repo] } : {}),
    })
    const limit = limitParam(c.req.query('limit'))
    const views: AgentTaskGroupView[] = []
    for (const group of groups) {
      if (views.length >= limit) break
      if (canSeeGroup(deps, principal, group))
        // oxlint-disable-next-line no-await-in-loop -- one view per visible group, newest first
        views.push(await groupView(taskDeps, principal, group))
    }
    return c.json<AgentTaskGroupList>({
      groups: views,
      people: await peopleOf(deps, peopleIds(views)),
    })
  })

  app.get('/task-groups/:id', async (c) => {
    const principal = principalOf(c)
    const group = await visibleGroup(principal, c.req.param('id'))
    await refreshTaskGroup(taskDeps, group.id).catch(() => {})
    const current = (await deps.store.tasks.getGroup(group.id)) ?? group
    const tasks = await deps.store.tasks.list({ groupIds: [group.id] })
    const view = await groupView(taskDeps, principal, current, tasks)
    const own = tasks.filter((task) => task.patch !== undefined && task.patch !== current.patch)
    return c.json<AgentTaskGroupDetail>({
      ...view,
      people: await peopleOf(deps, peopleIds([view])),
      ...(current.patch !== undefined && { patch: current.patch }),
      ...(own.length && {
        taskPatches: Object.fromEntries(own.map((task) => [task.id, task.patch!])),
      }),
    })
  })

  app.post('/task-groups', async (c) => {
    const principal = principalOf(c)
    const request = await readBody(c, taskGroupRequestSchema)
    const view = await guarded(() => createTaskGroup(taskDeps, principal, request))
    c.set('audit', {
      action: request.run ? 'task.run' : 'task.propose',
      target: { type: 'task-group', id: view.id },
      details: { kind: view.kind, repos: view.repos, title: view.title },
    })
    return c.json<AgentTaskGroupView>(view, 201)
  })

  app.post('/task-groups/:id/approve', async (c) => {
    const principal = principalOf(c)
    const group = await visibleGroup(principal, c.req.param('id'))
    const view = await guarded(() => approveTaskGroup(taskDeps, principal, group.id))
    c.set('audit', {
      action: 'task.approve',
      target: { type: 'task-group', id: group.id },
      details: { repos: view.repos },
    })
    return c.json<AgentTaskGroupView>(view)
  })

  app.post('/task-groups/:id/cancel', async (c) => {
    const principal = principalOf(c)
    const group = await visibleGroup(principal, c.req.param('id'))
    const view = await guarded(() => cancelTaskGroup(taskDeps, principal, group.id))
    c.set('audit', { action: 'task.cancel', target: { type: 'task-group', id: group.id } })
    return c.json<AgentTaskGroupView>(view)
  })

  app.post('/task-groups/:id/requests', async (c) => {
    const principal = principalOf(c)
    const group = await visibleGroup(principal, c.req.param('id'))
    const decision = await readBody(c, decisionSchema)
    const view = await guarded(() =>
      decideRepoRequest(taskDeps, principal, group.id, decision.repo, decision.approve),
    )
    c.set('audit', {
      action: decision.approve ? 'task.add_repo' : 'task.reject_repo',
      target: { type: 'task-group', id: group.id, repo: decision.repo },
    })
    return c.json<AgentTaskGroupView>(view)
  })

  const visibleTask = async (principal: Principal, id: string) => {
    const task = await deps.store.tasks.get(id)
    const group = task ? await deps.store.tasks.getGroup(task.groupId) : undefined
    if (!task || !group || !canSeeGroup(deps, principal, group))
      throw new HTTPException(404, { message: 'no such task' })
    return { task, group }
  }

  app.post('/tasks/:id/retry', async (c) => {
    const principal = principalOf(c)
    const { task, group } = await visibleTask(principal, c.req.param('id'))
    const view = await guarded(() => retryTask(taskDeps, principal, task.id))
    c.set('audit', {
      action: 'task.retry',
      target: { type: 'task-group', id: group.id, repo: task.repo },
    })
    return c.json<AgentTaskGroupView>(view)
  })

  app.post('/tasks/:id/cancel', async (c) => {
    const principal = principalOf(c)
    const { task, group } = await visibleTask(principal, c.req.param('id'))
    const view = await guarded(() => cancelTaskGroup(taskDeps, principal, group.id, task.id))
    c.set('audit', {
      action: 'task.cancel',
      target: { type: 'task-group', id: group.id, repo: task.repo },
    })
    return c.json<AgentTaskGroupView>(view)
  })

  app.get('/write-tasks', async (c) => {
    const principal = principalOf(c)
    const admin = can(principal, 'settings:read', GLOBAL)
    const [settings, pool] = await Promise.all([
      tasksWriteSettings(deps.store),
      writePoolStatus(deps.store),
    ])
    const { workers, ...counts } = pool
    return c.json<WriteTasksStatus>({
      ...settings,
      ...((admin || can(principal, 'ai:read', GLOBAL)) && {
        spentUsd: await weeklyWriteSpend(deps),
      }),
      pool: { ...counts, ...(admin && workers && { workers }) },
    })
  })

  app.get('/tasks/:id', async (c) => {
    const principal = principalOf(c)
    const { task, group } = await visibleTask(principal, c.req.param('id'))
    const view = await groupView(taskDeps, principal, group)
    const found = view.tasks.find((each) => each.id === task.id)
    if (!found) throw new HTTPException(404, { message: 'no such task' })
    return c.json<AgentTaskView>(found)
  })

  return app
}
