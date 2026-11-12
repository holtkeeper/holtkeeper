import { beforeEach, describe, expect, test } from 'bun:test'

import type { Principal } from '@holtkeeper/access'
import type { AgentTaskGroupView } from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import type { GitForge, MergeRequest, Pipeline } from '@holtkeeper/forge'
import { touchWorker } from '@holtkeeper/jobs'
import { builtinSettings } from '@holtkeeper/settings'
import type { Job, Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'
import { WRITE_TASK_KIND, type WriteTaskData, writeTaskOptionsSchema } from '@holtkeeper/write-task'

import { createApp } from '../src/app.ts'
import {
  createTaskGroup,
  decideRepoRequest,
  diffstatOf,
  postTaskCard,
  proposePropagateFixes,
  relatedRepos,
  requestRepository,
  taskJobFinished,
  taskStarted,
  taskToolsAccess,
} from '../src/tasks.ts'
import { writePoolStatus, writeTaskPolicy } from '../src/write-tasks.ts'

const mergeRequests = new Map<number, MergeRequest>()
const pipelines: Pipeline[] = []
const forge = {
  getMergeRequest: async (_repo: string, id: number) => ({
    ...mergeRequests.get(id)!,
    headSha: 'abc',
  }),
  listPipelines: async () => pipelines,
} as unknown as GitForge

const config = parseConfig({
  forges: { work: { kind: 'gitlab', url: 'https://gitlab.test', create: () => forge } },
  groups: {
    shapes: { forge: 'work', include: ['shapes/a', 'shapes/b', 'shapes/vendored'] },
    tools: { forge: 'work', include: ['tools/x', 'tools/y'] },
  },
  jobs: {},
})

const auth = headerAuth({
  roles: {
    shapes: [
      { scope: { groups: ['shapes'] }, actions: ['tasks:run', 'repos:read', 'analyses:read'] },
    ],
    helper: [
      { scope: { groups: ['shapes'] }, actions: ['tasks:run', 'repos:read'] },
      { scope: { repos: ['work:tools/x'] }, actions: ['tasks:run'] },
    ],
    reader: [{ scope: { groups: ['shapes'] }, actions: ['repos:read'] }],
  },
})
const asShapes = { 'x-forwarded-user': 'jane', 'x-forwarded-groups': 'shapes' }
const asHelper = { 'x-forwarded-user': 'kai', 'x-forwarded-groups': 'helper' }
const asReader = { 'x-forwarded-user': 'bob', 'x-forwarded-groups': 'reader' }

const jane: Principal = {
  id: 'header:jane',
  name: 'jane',
  provider: 'header',
  grants: [
    { scope: { groups: ['shapes'] }, actions: ['tasks:run', 'repos:read', 'analyses:read'] },
  ],
}

const now = new Date('2026-11-11T12:00:00.000Z')
let store: Store
let app: ReturnType<typeof createApp>

const deps = () => ({
  store,
  config,
  now: () => now,
  readOnly: async (repo: { path: string }) => repo.path === 'shapes/vendored',
})

const setting = (key: string, value: unknown, scope: Record<string, unknown> = { all: true }) =>
  store.settings.put({
    id: `${key}:${JSON.stringify(scope)}`,
    key,
    scope,
    value,
    secret: false,
    updatedAt: now.toISOString(),
  })

beforeEach(() => {
  store = memoryStore()
  mergeRequests.clear()
  pipelines.length = 0
  const vault = aesVault('v'.repeat(32))
  app = createApp({
    config,
    auth,
    store,
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: builtinSettings,
    analyses: [],
    analyzers: [{ kind: WRITE_TASK_KIND, scope: 'repo', options: writeTaskOptionsSchema }],
    readOnly: async (repo) => repo.path === 'shapes/vendored',
    now: () => now,
  })
})

const call = (method: string, path: string, headers = asShapes, body?: unknown) =>
  app.request(`/api${path}`, {
    method,
    headers: { ...headers, 'content-type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })

const propose = (body: Record<string, unknown>, headers = asShapes) =>
  call('POST', '/task-groups', headers, {
    title: 'Rename the widget prop',
    prompt: 'Rename size to scale.',
    ...body,
  })

const byText = (a: string, b: string) => a.localeCompare(b)

const refusal = (...args: Parameters<typeof taskStarted>) =>
  taskStarted(...args).then(
    () => 'started',
    (error: unknown) => String(error),
  )

const spend = (costUsd: number, jobId?: string) =>
  store.aiUsage.append({
    at: '2026-11-10T09:00:00.000Z',
    repo: { forge: 'work', path: 'shapes/a' },
    groups: ['shapes'],
    taskKind: WRITE_TASK_KIND,
    actor: 'header:jane',
    provider: 'anthropic',
    model: 'claude-sonnet',
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd,
    costSource: 'computed',
    durationMs: 1,
    turns: 1,
    outcome: 'ok',
    ...(jobId !== undefined && { jobId }),
  })

const finished = (job: Job, data: Partial<WriteTaskData>, status: Job['status'] = 'succeeded') =>
  taskJobFinished(
    deps(),
    { ...job, status },
    {
      id: 'rec',
      kind: WRITE_TASK_KIND,
      repo: job.repo,
      createdAt: now.toISOString(),
      data: {
        taskId: 'g',
        title: 'Rename the widget prop',
        kind: 'change',
        status: 'opened',
        branch: 'b',
        targetBranch: 'main',
        path: 'agent',
        files: ['src/widget.ts'],
        checks: [],
        ...data,
      },
    },
  )

describe('task group routes', () => {
  test('a proposal waits for approval, and approving is refused while the kill switch is off', async () => {
    const response = await propose({ repos: ['work:shapes/a'] })
    expect(response.status).toBe(201)
    const group = (await response.json()) as AgentTaskGroupView
    expect(group).toMatchObject({
      status: 'proposed',
      proposedBy: 'header:jane',
      source: { type: 'api' },
      can: { approve: true, cancel: true },
    })
    expect(group.tasks.map((task) => task.status)).toEqual(['proposed'])
    expect(group.tasks[0]?.branch).toBe(`holtkeeper/${group.id}-rename-the-widget-prop`)

    const refused = await call('POST', `/task-groups/${group.id}/approve`)
    expect(refused.status).toBe(409)
    expect(await refused.text()).toContain('turned off')
    expect(await store.jobs.list()).toEqual([])
  })

  test('approving queues one job per repository on the same branch, split within the group cap', async () => {
    await setting('tasks.write', { enabled: true, perGroupUsd: 2 })
    const response = await propose({
      repos: ['work:shapes/a', 'work:shapes/b', 'work:shapes/a'],
      kind: 'upgrade',
      run: true,
    })
    expect(response.status).toBe(201)
    const group = (await response.json()) as AgentTaskGroupView
    expect(group.status).toBe('queued')
    const jobs = await store.jobs.list()
    expect(jobs).toHaveLength(2)
    for (const job of jobs) {
      expect(job).toMatchObject({
        analyzer: WRITE_TASK_KIND,
        trigger: 'manual',
        maxAttempts: 1,
        actor: 'header:jane',
      })
      const options = writeTaskOptionsSchema.parse(job.options)
      const task = group.tasks.find((each) => each.jobId === job.id)
      expect(options).toMatchObject({
        taskId: group.id,
        task: task?.id,
        kind: 'change',
        budgetUsd: 1,
        group: group.id,
      })
    }
    expect(group.tasks.every((task) => task.requester === 'header:jane')).toBe(true)
  })

  test('needs tasks:run on every target, explicitly for other teams, and refuses read-only ones', async () => {
    await setting('tasks.write', { enabled: true })
    const readerGroup = (await (
      await propose({ repos: ['work:shapes/a'] }, asReader)
    ).json()) as AgentTaskGroupView
    expect(readerGroup.can.approve).toBe(false)
    expect((await call('POST', `/task-groups/${readerGroup.id}/approve`, asReader)).status).toBe(
      403,
    )

    expect((await propose({ repos: ['work:tools/x'] })).status).toBe(201)
    const crossTeam = (await (
      await propose({ repos: ['work:shapes/a', 'work:tools/x'] })
    ).json()) as AgentTaskGroupView
    expect((await call('POST', `/task-groups/${crossTeam.id}/approve`)).status).toBe(403)
    expect((await call('POST', `/task-groups/${crossTeam.id}/approve`, asHelper)).status).toBe(200)
    expect((await propose({ repos: ['work:tools/y'], run: true }, asHelper)).status).toBe(403)

    const readOnly = await propose({ repos: ['work:shapes/vendored'], run: true })
    expect(readOnly.status).toBe(409)
    expect(await readOnly.text()).toContain('read-only')
    expect((await propose({ repos: ['other:shapes/a'] })).status).toBe(400)
    expect((await propose({ repos: ['work:shapes/a'], prompt: undefined })).status).toBe(400)
    expect(await store.jobs.list()).toHaveLength(2)
  })

  test('stops approving once the weekly write task spend is reached', async () => {
    await setting('tasks.write', { enabled: true, weeklyUsd: 2 })
    await spend(2.1)
    const response = await propose({ repos: ['work:shapes/a'], run: true })
    expect(response.status).toBe(409)
    expect(await response.text()).toContain('this week')
  })

  test('the weekly cap counts the caps queued tasks hold', async () => {
    await setting('tasks.write', { enabled: true, weeklyUsd: 4 })
    expect((await propose({ repos: ['work:shapes/a', 'work:shapes/b'], run: true })).status).toBe(
      201,
    )
    const refused = await propose({ repos: ['work:shapes/a'], run: true })
    expect(refused.status).toBe(409)
    expect(await refused.text()).toContain('hold $3.00')
    expect(await store.jobs.list()).toHaveLength(2)
  })

  test('a second approval of the same group queues nothing more', async () => {
    await setting('tasks.write', { enabled: true })
    const group = (await (
      await propose({ repos: ['work:shapes/a', 'work:shapes/b'] })
    ).json()) as AgentTaskGroupView
    await Promise.all([
      call('POST', `/task-groups/${group.id}/approve`),
      call('POST', `/task-groups/${group.id}/approve`),
    ])
    const jobs = await store.jobs.list()
    const ids = jobs.map((job) => writeTaskOptionsSchema.parse(job.options).task ?? '')
    expect(ids.toSorted(byText)).toEqual(group.tasks.map((task) => task.id).toSorted(byText))
    expect((await call('POST', `/task-groups/${group.id}/approve`)).status).toBe(409)
    expect(await store.jobs.list()).toHaveLength(2)
  })

  test('cancelling stops queued jobs; only the proposer or a task runner may cancel', async () => {
    await setting('tasks.write', { enabled: true })
    const group = (await (
      await propose({ repos: ['work:shapes/a'], run: true })
    ).json()) as AgentTaskGroupView
    expect((await call('POST', `/task-groups/${group.id}/cancel`, asReader)).status).toBe(403)
    const cancelled = (await (
      await call('POST', `/task-groups/${group.id}/cancel`)
    ).json()) as AgentTaskGroupView
    expect(cancelled.status).toBe('cancelled')
    expect((await store.jobs.get(group.tasks[0]!.jobId!))?.status).toBe('canceled')
    expect((await call('POST', `/task-groups/${group.id}/cancel`)).status).toBe(409)
  })

  test('lists only groups with a visible target and hides others', async () => {
    const own = (await (await propose({ repos: ['work:shapes/a'] })).json()) as AgentTaskGroupView
    await propose({ repos: ['work:tools/x'] }, asHelper)
    const listed = (await (await call('GET', '/task-groups', asReader)).json()) as {
      groups: AgentTaskGroupView[]
    }
    expect(listed.groups.map((group) => group.id)).toEqual([own.id])
    expect((await call('GET', `/task-groups/${own.id}`, asReader)).status).toBe(200)
    const other = (await store.tasks.listGroups()).find((group) => group.id !== own.id)!
    expect((await call('GET', `/task-groups/${other.id}`, asReader)).status).toBe(404)
    expect((await call('GET', `/tasks/${own.tasks[0]!.id}`, asReader)).status).toBe(200)
  })

  test('a failed task runs again as a new job; one task can be cancelled alone', async () => {
    await setting('tasks.write', { enabled: true })
    const group = (await (
      await propose({ repos: ['work:shapes/a', 'work:shapes/b'], run: true })
    ).json()) as AgentTaskGroupView
    const [first, second] = group.tasks
    expect(first?.can).toEqual({ retry: false, cancel: true })
    expect((await call('POST', `/tasks/${first!.id}/retry`)).status).toBe(409)

    const job = (await store.jobs.get(first!.jobId!))!
    await taskJobFinished(deps(), { ...job, status: 'failed', error: 'checks failed' })
    const listed = (await (await call('GET', '/task-groups')).json()) as {
      groups: AgentTaskGroupView[]
      people: Record<string, unknown>
    }
    expect(listed.people).toEqual({})
    const failed = listed.groups[0]!.tasks.find((task) => task.id === first!.id)
    expect(failed).toMatchObject({ status: 'failed', can: { retry: true, cancel: false } })
    expect((await call('POST', `/tasks/${first!.id}/retry`, asReader)).status).toBe(403)

    const retried = (await (
      await call('POST', `/tasks/${first!.id}/retry`)
    ).json()) as AgentTaskGroupView
    const again = retried.tasks.find((task) => task.id === first!.id)!
    expect(again.status).toBe('queued')
    expect(again.error).toBeUndefined()
    expect(again.jobId).not.toBe(job.id)
    expect(await store.jobs.list()).toHaveLength(3)

    expect((await call('POST', `/tasks/${second!.id}/cancel`, asReader)).status).toBe(403)
    const cancelled = (await (
      await call('POST', `/tasks/${second!.id}/cancel`)
    ).json()) as AgentTaskGroupView
    expect(cancelled.tasks.map((task) => task.status)).toEqual(['queued', 'cancelled'])
    expect(cancelled.cancelledBy).toBeUndefined()
    expect((await store.jobs.get(second!.jobId!))?.status).toBe('canceled')
  })

  test('write task status shows the switch, caps and the pool; spend and workers only to admins', async () => {
    await setting('tasks.write', { enabled: true, perRepoUsd: 1 })
    await propose({ repos: ['work:shapes/a'], run: true })
    const status = (await (await call('GET', '/write-tasks', asReader)).json()) as Record<
      string,
      unknown
    >
    expect(status).toMatchObject({
      enabled: true,
      perRepoUsd: 1,
      perGroupUsd: 5,
      weeklyUsd: 40,
      pool: { queued: 1, running: 0, oldestQueuedAt: now.toISOString() },
    })
    expect(status.spentUsd).toBeUndefined()
    expect((status.pool as Record<string, unknown>).workers).toBeUndefined()
  })

  test('the write pool counts busy workers against the live workers in the registry', async () => {
    await setting('tasks.write', { enabled: true, perRepoUsd: 1 })
    await propose({ repos: ['work:shapes/a', 'work:shapes/b'], run: true })
    await touchWorker(store.kv!, 'w-busy', now)
    await touchWorker(store.kv!, 'w-idle', now)
    await touchWorker(store.kv!, 'w-gone', new Date(now.getTime() - 10 * 60_000))
    await store.jobs.claim('w-busy', now.toISOString(), { only: [WRITE_TASK_KIND] })
    const pool = await writePoolStatus(store, now)
    expect(pool).toMatchObject({ queued: 1, running: 1, busyWorkers: 1, totalWorkers: 2 })
    expect(pool.workers).toEqual(['w-busy'])
    const { kv: _kv, ...withoutKv } = store
    expect((await writePoolStatus(withoutKv, now)).totalWorkers).toBeUndefined()
    const status = (await (await call('GET', '/write-tasks', asReader)).json()) as {
      pool: Record<string, unknown>
    }
    expect(status.pool).toMatchObject({ busyWorkers: 1, totalWorkers: 2 })
  })

  test('a patch needs tasks:run to propose, and approvers see it in full', async () => {
    const patch = 'diff --git a/widget.ts b/widget.ts\n'
    expect((await propose({ repos: ['work:shapes/a'], patch }, asReader)).status).toBe(403)
    const group = (await (
      await propose({ repos: ['work:shapes/a'], patch })
    ).json()) as AgentTaskGroupView
    expect(group.hasPatch).toBe(true)
    const detail = (await (await call('GET', `/task-groups/${group.id}`)).json()) as Record<
      string,
      unknown
    >
    expect(detail.patch).toBe(patch)
    expect(detail.taskPatches).toBeUndefined()
  })

  test('the generic job route does not queue write tasks', async () => {
    const response = await call('POST', '/jobs', asShapes, {
      analyzer: WRITE_TASK_KIND,
      repo: 'work:shapes/a',
    })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('POST /api/task-groups')
  })
})

const thread = async () =>
  store.chat.createThread({
    id: 'th1',
    title: 'Widgets',
    createdBy: 'header:jane',
    createdAt: now.toISOString(),
    participants: {},
  } as Parameters<Store['chat']['createThread']>[0])

const failAll = (group: AgentTaskGroupView) =>
  Promise.all(
    group.tasks.map(async (task) => {
      const job = (await store.jobs.get(task.jobId!))!
      await taskJobFinished(deps(), { ...job, status: 'failed', error: 'checks failed' })
    }),
  )

describe('task group retry, reject and badge', () => {
  test('retries every failed task of a group under the task retry rules, audited', async () => {
    await setting('tasks.write', { enabled: true })
    const group = (await (
      await propose({ repos: ['work:shapes/a', 'work:shapes/b'], run: true })
    ).json()) as AgentTaskGroupView
    expect(group.can.retry).toBe(false)
    expect((await call('POST', `/task-groups/${group.id}/retry`)).status).toBe(409)

    await failAll(group)
    const failed = (await (
      await call('GET', `/task-groups/${group.id}`)
    ).json()) as AgentTaskGroupView
    expect(failed.can.retry).toBe(true)
    expect((await call('POST', `/task-groups/${group.id}/retry`, asReader)).status).toBe(403)

    const retried = await call('POST', `/task-groups/${group.id}/retry`)
    expect(retried.status).toBe(200)
    const view = (await retried.json()) as AgentTaskGroupView
    expect(view.tasks.map((task) => task.status)).toEqual(['queued', 'queued'])
    expect(await store.jobs.list()).toHaveLength(4)
    const [event] = (await store.audit.list({ action: 'task.retry', outcome: 'ok' })).events
    expect(event?.target).toMatchObject({ type: 'task-group', id: group.id })
  })

  test('group retry respects the weekly cap and retries nothing when refused', async () => {
    await setting('tasks.write', { enabled: true, weeklyUsd: 3 })
    const group = (await (
      await propose({ repos: ['work:shapes/a', 'work:shapes/b'], run: true })
    ).json()) as AgentTaskGroupView
    await failAll(group)
    await spend(2.5)
    const refused = await call('POST', `/task-groups/${group.id}/retry`)
    expect(refused.status).toBe(409)
    expect(await refused.text()).toContain('this week')
    expect((await store.tasks.list({ groupIds: [group.id] })).map((task) => task.status)).toEqual([
      'failed',
      'failed',
    ])
  })

  test('rejecting cancels a proposed group as task.reject and refuses other states', async () => {
    const group = (await (await propose({ repos: ['work:shapes/a'] })).json()) as AgentTaskGroupView
    expect(group.can.reject).toBe(true)
    expect((await call('POST', `/task-groups/${group.id}/reject`, asReader)).status).toBe(403)

    const rejected = await call('POST', `/task-groups/${group.id}/reject`)
    expect(rejected.status).toBe(200)
    expect(((await rejected.json()) as AgentTaskGroupView).status).toBe('cancelled')
    const [event] = (await store.audit.list({ action: 'task.reject', outcome: 'ok' })).events
    expect(event?.target).toMatchObject({
      type: 'task-group',
      id: group.id,
      repo: 'work:shapes/a',
    })
    expect((await call('POST', `/task-groups/${group.id}/reject`)).status).toBe(409)

    await setting('tasks.write', { enabled: true })
    const after = (await (
      await call('GET', `/task-groups/${group.id}`)
    ).json()) as AgentTaskGroupView
    expect(after.can.retry).toBe(false)
    expect(after.tasks.map((task) => task.can.retry)).toEqual([false])
    expect((await call('POST', `/task-groups/${group.id}/retry`)).status).toBe(409)
    expect((await call('POST', `/tasks/${after.tasks[0]!.id}/retry`)).status).toBe(409)

    const running = (await (
      await propose({ repos: ['work:shapes/a'], run: true })
    ).json()) as AgentTaskGroupView
    expect(running.can.reject).toBe(false)
    expect((await call('POST', `/task-groups/${running.id}/reject`)).status).toBe(409)
  })

  test('counts proposed groups the caller sees for the Tasks badge', async () => {
    await propose({ repos: ['work:shapes/a'] })
    await propose({ repos: ['work:shapes/b'] })
    await propose({ repos: ['work:tools/x'] }, asHelper)
    const count = async (headers: typeof asShapes) =>
      (
        (await (await call('GET', '/task-groups/needs-approval', headers)).json()) as {
          count: number
        }
      ).count
    expect(await count(asReader)).toBe(2)
    expect(await count(asHelper)).toBe(3)
    const first = (await store.tasks.listGroups()).find((group) =>
      group.repos.includes('work:shapes/a'),
    )
    await call('POST', `/task-groups/${first!.id}/reject`)
    expect(await count(asReader)).toBe(1)
  })

  test('tasks show the diffstat of their patch, then of the merge request, and its CI', async () => {
    await setting('tasks.write', { enabled: true })
    const patch = [
      'diff --git a/src/widget.ts b/src/widget.ts',
      '--- a/src/widget.ts',
      '+++ b/src/widget.ts',
      '@@ -1,3 +1,3 @@',
      ' export const size = 1',
      '-export const scale = 2',
      '+export const scale = 3',
      ' export const depth = 4',
      'diff --git a/src/shape.ts b/src/shape.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/shape.ts',
      '@@ -0,0 +1,2 @@',
      '+--- not a header',
      '++++ not a header either',
    ].join('\n')
    expect(diffstatOf(patch)).toEqual({ files: 2, additions: 3, deletions: 1 })

    const group = (await (
      await propose({ repos: ['work:shapes/a'], patch, prompt: undefined, run: true })
    ).json()) as AgentTaskGroupView
    expect(group.tasks[0]).toMatchObject({
      ci: 'none',
      diffstat: { files: 2, additions: 3, deletions: 1, source: 'patch' },
    })

    const [job] = await store.jobs.list()
    const options = writeTaskOptionsSchema.parse(job!.options)
    await taskStarted(deps(), job!.repo, options, job!.id)
    await finished(job!, {
      mergeRequest: { id: 9, url: 'https://gitlab.test/shapes/a/-/merge_requests/9', draft: false },
    })
    mergeRequests.set(9, {
      id: 9,
      title: 'fix: scale',
      description: '',
      sourceBranch: 'b',
      targetBranch: 'main',
      state: 'open',
      draft: false,
      labels: [],
      author: 'holtkeeper',
      webUrl: 'https://gitlab.test/shapes/a/-/merge_requests/9',
    })
    pipelines.push({
      id: 2,
      ref: 'b',
      sha: 'abc',
      status: 'running',
      webUrl: 'https://gitlab.test/p/2',
    })
    const diffForge = forge as GitForge & { getMergeRequestDiff?: unknown }
    diffForge.getMergeRequestDiff = async () => ({
      refs: { baseSha: 'a', headSha: 'abc', startSha: 'a' },
      files: [
        {
          oldPath: 'src/widget.ts',
          newPath: 'src/widget.ts',
          status: 'modified',
          diff: '@@ -1,2 +1,3 @@\n-old\n+new\n+more\n context',
        },
      ],
    })
    try {
      const listed = (await (await call('GET', '/task-groups')).json()) as {
        groups: AgentTaskGroupView[]
      }
      expect(listed.groups[0]?.tasks[0]).toMatchObject({
        status: 'mr-open',
        ci: 'running',
        diffstat: { files: 1, additions: 2, deletions: 1, source: 'merge-request' },
      })
    } finally {
      delete diffForge.getMergeRequestDiff
    }
  })
})

describe('task lifecycle', () => {
  test('job progress updates the task, the chat card in place and links the merge request', async () => {
    await setting('tasks.write', { enabled: true })
    await thread()
    const proposed = await createTaskGroup(
      deps(),
      jane,
      {
        kind: 'chat',
        title: 'Rename the widget prop',
        prompt: 'Rename it.',
        repos: ['work:shapes/a'],
      },
      { source: { type: 'chat', threadId: 'th1' } },
    )
    await postTaskCard(deps(), proposed, 'Rename it.', 1.5)
    const card = () => store.chat.listMessages('th1').then((messages) => messages[0]?.card)
    expect(JSON.stringify(await card())).toContain('"status":"proposed"')

    const response = await call('POST', `/task-groups/${proposed.id}/approve`)
    expect(response.status).toBe(200)
    expect(JSON.stringify(await card())).toContain('"status":"queued"')

    const [job] = await store.jobs.list()
    const options = writeTaskOptionsSchema.parse(job!.options)
    await taskStarted(deps(), job!.repo, options, job!.id)
    expect((await store.tasks.get(options.task!))?.status).toBe('running')

    await finished(job!, {
      mergeRequest: { id: 7, url: 'https://gitlab.test/shapes/a/-/merge_requests/7', draft: true },
      agent: {
        summary: 'Renamed.',
        changes: [],
        remainingProblems: [],
        turns: 3,
        costUsd: 0.42,
        transcriptRef: 'transcripts/x.jsonl',
      },
    })
    const task = await store.tasks.get(options.task!)
    expect(task).toMatchObject({
      status: 'mr-open',
      costUsd: 0.42,
      transcriptRef: 'transcripts/x.jsonl',
      mergeRequest: { id: 7, draft: true, state: 'open' },
    })
    const messages = await store.chat.listMessages('th1')
    expect(JSON.stringify(messages[0]?.card)).toContain('"status":"mr-open"')
    expect(JSON.stringify(messages[0]?.card)).toContain('merge_requests/7')
    expect(messages.at(-1)?.body).toContain('[!7](https://gitlab.test/shapes/a/-/merge_requests/7)')

    mergeRequests.set(7, {
      id: 7,
      title: 'fix: rename',
      description: '',
      sourceBranch: 'b',
      targetBranch: 'main',
      state: 'merged',
      draft: false,
      labels: [],
      author: 'holtkeeper',
      webUrl: 'https://gitlab.test/shapes/a/-/merge_requests/7',
    })
    pipelines.push({
      id: 1,
      ref: 'b',
      sha: 'abc',
      status: 'success',
      webUrl: 'https://gitlab.test/p/1',
    })
    const view = (await (
      await call('GET', `/task-groups/${proposed.id}`)
    ).json()) as AgentTaskGroupView
    expect(view.status).toBe('done')
    expect(view.tasks[0]?.mergeRequest).toMatchObject({ state: 'merged', ci: 'success' })
  })

  test('failed jobs fail the task and say so in the thread', async () => {
    await setting('tasks.write', { enabled: true })
    await thread()
    const group = await createTaskGroup(
      deps(),
      jane,
      { title: 'Fix the widget', prompt: 'Fix it.', repos: ['work:shapes/a'], run: true },
      { source: { type: 'chat', threadId: 'th1' } },
    )
    const [job] = await store.jobs.list()
    await spend(1.5, job!.id)
    await taskJobFinished(deps(), { ...job!, status: 'blocked', error: 'budget stop' })
    expect(await store.tasks.get(group.tasks[0]!.id)).toMatchObject({
      status: 'failed',
      error: 'budget stop',
      costUsd: 1.5,
    })
    expect((await store.chat.listMessages('th1')).at(-1)?.body).toContain('budget stop')
  })

  test('retries add up their spend and stay within the group cap', async () => {
    await setting('tasks.write', { enabled: true, perGroupUsd: 2.5 })
    const group = await createTaskGroup(deps(), jane, {
      title: 'Fix the widget',
      prompt: 'Fix it.',
      repos: ['work:shapes/a'],
      run: true,
    })
    const taskId = group.tasks[0]!.id
    const [first] = await store.jobs.list()
    await spend(1.5, first!.id)
    await taskJobFinished(deps(), { ...first!, status: 'blocked', error: 'budget stop' })

    const retried = (await (
      await call('POST', `/tasks/${taskId}/retry`)
    ).json()) as AgentTaskGroupView
    expect(retried.tasks[0]).toMatchObject({ status: 'queued', budgetUsd: 1, costUsd: 1.5 })
    const second = (await store.jobs.get(retried.tasks[0]!.jobId!))!
    await taskJobFinished(deps(), first!)
    expect((await store.tasks.get(taskId))?.status).toBe('queued')

    await spend(1, second.id)
    await taskJobFinished(deps(), { ...second, status: 'failed', error: 'checks failed' })
    expect((await store.tasks.get(taskId))?.costUsd).toBe(2.5)
    const refused = await call('POST', `/tasks/${taskId}/retry`)
    expect(refused.status).toBe(409)
    expect(await refused.text()).toContain('spend cap')
  })

  test('a worker starts only the job an approved task queued', async () => {
    await setting('tasks.write', { enabled: true })
    const group = await createTaskGroup(deps(), jane, {
      title: 'Fix the widget',
      prompt: 'Fix it.',
      repos: ['work:shapes/a'],
      run: true,
    })
    const task = group.tasks[0]!
    const [job] = await store.jobs.list()
    const options = writeTaskOptionsSchema.parse(job!.options)
    const repoA = { forge: 'work', path: 'shapes/a' }
    expect(await refusal(deps(), repoA, { taskId: 'abcd1' }, 'job-x')).toContain(
      'approved task groups',
    )
    expect(await refusal(deps(), repoA, options, 'job-x')).toContain('another job')
    expect(await refusal(deps(), { forge: 'work', path: 'shapes/b' }, options, job!.id)).toContain(
      'does not match',
    )
    expect((await store.tasks.get(task.id))?.status).toBe('queued')
    expect(await refusal(deps(), repoA, options, job!.id)).toBe('started')
    expect((await store.tasks.get(task.id))?.status).toBe('running')
    expect(await refusal(deps(), repoA, options, job!.id)).toContain('the task is running')
  })

  test('a chat card changes only for its own group in its own thread', async () => {
    await thread()
    const own = await createTaskGroup(
      deps(),
      jane,
      { title: 'Rename the widget prop', prompt: 'Rename it.', repos: ['work:shapes/a'] },
      { source: { type: 'chat', threadId: 'th1' } },
    )
    await postTaskCard(deps(), own, 'Rename it.')
    const [message] = await store.chat.listMessages('th1')
    const forged = await propose({
      repos: ['work:shapes/a', 'work:shapes/b'],
      source: { type: 'chat', threadId: 'th1', messageId: message!.id },
    })
    expect(forged.status).toBe(400)

    const other = (await (
      await propose({ repos: ['work:shapes/a', 'work:shapes/b'] })
    ).json()) as AgentTaskGroupView
    const stored = (await store.tasks.getGroup(other.id))!
    await store.tasks.putGroup({
      ...stored,
      source: { type: 'chat', threadId: 'th1', messageId: message!.id },
    })
    expect((await call('POST', `/tasks/${other.tasks[1]!.id}/cancel`)).status).toBe(200)
    const card = (await store.chat.getMessage(message!.id))?.card
    expect(JSON.stringify(card)).toContain(own.id)
    expect(JSON.stringify(card)).not.toContain(other.id)
  })

  test('agents see related repositories and ask to add one; a person decides', async () => {
    await setting('tasks.write', { enabled: true })
    await store.jobs.enqueue({
      analyzer: 'stack',
      repo: { forge: 'work', path: 'shapes/b' },
      options: {},
      trigger: 'manual',
      createdAt: now.toISOString(),
    })
    const group = await createTaskGroup(deps(), jane, {
      title: 'Fix the widget',
      prompt: 'Fix it.',
      repos: ['work:shapes/a'],
      run: true,
    })
    const options = { task: group.tasks[0]!.id }
    expect(await relatedRepos(deps(), { forge: 'work', path: 'shapes/a' }, options)).toEqual([
      { repo: 'work:shapes/b', relation: 'same group shapes' },
    ])
    expect(
      await requestRepository(deps(), { options, target: 'work:shapes/b', reason: 'shares it' }),
    ).toContain('Asked people')
    expect(
      await requestRepository(deps(), { options, target: 'work:shapes/b', reason: 'again' }),
    ).toContain('already requested')

    const decided = await decideRepoRequest(deps(), jane, group.id, 'work:shapes/b', true)
    expect(decided.repos).toEqual(['work:shapes/a', 'work:shapes/b'])
    expect(decided.tasks.map((task) => task.status)).toEqual(['queued', 'queued'])
    expect(decided.requests?.[0]).toMatchObject({ status: 'approved', decidedBy: 'header:jane' })
  })
})

const oneFix = (repo: string) => ({
  group: 'shapes',
  title: 'chore(deps): update some-lib to 2.0.0',
  fixes: [{ repo, prompt: 'x', patch: 'y' }],
})

describe('propagate fix tasks', () => {
  test('one proposed group per rollout, each task with its own prompt and patch', async () => {
    await setting('tasks.write', { enabled: true, perGroupUsd: 2 })
    const proposed = await proposePropagateFixes(deps(), {
      group: 'shapes',
      title: 'chore(deps): update some-lib to 2.0.0',
      fixes: [
        { repo: 'work:shapes/a', prompt: 'fix a', patch: 'diff a' },
        { repo: 'other:shapes/b', prompt: 'unknown forge', patch: 'diff' },
        { repo: 'work:shapes/b', prompt: 'fix b', patch: 'diff b' },
      ],
    })
    expect(proposed).toBeDefined()
    const group = await store.tasks.getGroup(proposed!.groupId)
    expect(group).toMatchObject({
      kind: 'propagate-fix',
      proposedBy: 'analyzer:propagate',
      source: { type: 'propagate', group: 'shapes' },
      repos: ['work:shapes/a', 'work:shapes/b'],
      budgetClass: 'automatic',
    })
    const tasks = (await store.tasks.list({ groupIds: [proposed!.groupId] })).toSorted((a, b) =>
      a.repo.localeCompare(b.repo),
    )
    expect(tasks.map((task) => [task.repo, task.status, task.prompt, task.patch])).toEqual([
      ['work:shapes/a', 'proposed', 'fix a', 'diff a'],
      ['work:shapes/b', 'proposed', 'fix b', 'diff b'],
    ])
    expect(proposed!.tasks).toEqual({
      'work:shapes/a': tasks[0]!.id,
      'work:shapes/b': tasks[1]!.id,
    })
    expect(await store.jobs.list()).toEqual([])

    const approved = await call('POST', `/task-groups/${proposed!.groupId}/approve`)
    expect(approved.status).toBe(200)
    const jobs = await store.jobs.list()
    expect(jobs.map((job) => job.trigger)).toEqual(['manual', 'manual'])
    const options = jobs
      .map((job) => writeTaskOptionsSchema.parse(job.options))
      .toSorted((a, b) => (a.prompt ?? '').localeCompare(b.prompt ?? ''))
    expect(options.map((each) => [each.kind, each.prompt, each.patch, each.budgetUsd])).toEqual([
      ['fix', 'fix a', 'diff a', 1],
      ['fix', 'fix b', 'diff b', 1],
    ])
  })

  test('proposes nothing without a known repository or while write tasks are off', async () => {
    expect(await proposePropagateFixes(deps(), oneFix('work:shapes/a'))).toBeUndefined()
    await setting('tasks.write', { enabled: true })
    expect(await proposePropagateFixes(deps(), oneFix('other:shapes/a'))).toBeUndefined()
    expect(await store.tasks.listGroups()).toEqual([])
  })
})

describe('MCP task tools', () => {
  test('start_task only proposes without the tasks scope, and runs with it', async () => {
    await setting('tasks.write', { enabled: true })
    const input = {
      kind: 'fix' as const,
      title: 'Fix the widget',
      prompt: 'Fix it.',
      repos: ['work:shapes/a'],
      run: true,
    }
    const proposedOnly = await taskToolsAccess(deps(), jane, { mayRun: false }).start(input)
    expect(proposedOnly).toMatchObject({ started: false, group: { status: 'proposed' } })
    expect(proposedOnly.reason).toContain('tasks scope')

    const access = taskToolsAccess(deps(), jane, { mayRun: true, client: 'some-agent' })
    const started = await access.start(input)
    expect(started).toMatchObject({
      started: true,
      group: { status: 'queued', source: { type: 'mcp', client: 'some-agent' } },
    })
    expect((await store.jobs.list())[0]?.trigger).toBe('command')
    expect((await access.status(started.group.tasks[0]!.id))?.id).toBe(started.group.id)

    expect(access.requestReview(started.group.id)).rejects.toThrow('no open merge request')
    const [job] = await store.jobs.list()
    await finished(job!, { mergeRequest: { id: 9, url: 'https://gitlab.test/mr/9', draft: true } })
    expect(await access.requestReview(started.group.id)).toContain('!9')
    expect((await store.jobs.list({ analyzer: 'review' }))[0]).toMatchObject({
      options: { mergeRequest: 9, reviewOwn: true },
      trigger: 'command',
    })
  })
})

describe('writeTaskPolicy', () => {
  test('reads the switch, read-only, dry run, the sandbox and the weekly cap when a task starts', async () => {
    let mode: string | undefined = 'mise'
    const policy = writeTaskPolicy({
      store,
      readOnly: async (repo) => repo.path === 'shapes/vendored',
      dryRun: () => true,
      executionMode: () => mode,
      now: () => now,
    })
    expect(await policy({ forge: 'work', path: 'shapes/a' })).toEqual({
      enabled: false,
      readOnly: false,
      dryRun: true,
      unsandboxed: false,
      weeklyCapReached: false,
    })
    await setting('tasks.write', { enabled: true, weeklyUsd: 2 })
    await spend(2.1)
    mode = undefined
    expect(await policy({ forge: 'work', path: 'shapes/vendored' })).toEqual({
      enabled: true,
      readOnly: true,
      dryRun: true,
      unsandboxed: true,
      weeklyCapReached: true,
    })
  })
})
