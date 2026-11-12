import { type Principal, type RepoTarget, can } from '@holtkeeper/access'
import { ToolError } from '@holtkeeper/agent-tools'
import type { AgentTaskGroupView, AgentTaskView, ForbiddenError } from '@holtkeeper/api'
import { type TaskCardMergeRequest, taskCard, taskSteps } from '@holtkeeper/chat'
import type { RepoRef } from '@holtkeeper/forge'
import type { FixProposer } from '@holtkeeper/propagate'
import {
  type AgentTask,
  type AgentTaskCi,
  type AgentTaskDiffstat,
  type AgentTaskGroup,
  type AgentTaskKind,
  type AgentTaskSource,
  type AgentTaskStatus,
  type AnalysisRecord,
  type ChatMessageRef,
  type Job,
  type JobTrigger,
  agentGroupStatus,
  finalTaskStatuses,
} from '@holtkeeper/store'
import {
  type RelatedRepo,
  WRITE_TASK_KIND,
  WriteTaskRefusedError,
  type WriteTaskData,
  type WriteTaskOptions,
  taskBranch,
  writeTaskDataSchema,
  writeTaskOptionsSchema,
} from '@holtkeeper/write-task'
import { z } from 'zod'

import { type ServerDeps, forgeFor, repoKey, repoTarget, ForbiddenToolError } from './context.ts'
import type { ReadOnlyRepos } from './read-only.ts'
import type { TaskToolsAccess } from './tools/tasks.ts'
import { canSeeCatalog, crossTeamPolicy } from './visibility.ts'
import { tasksWriteSettings, weeklyWriteSpend } from './write-tasks.ts'

/** Kinds of agent tasks, in the order forms list them. */
export const agentTaskKinds = [
  'fix',
  'port',
  'upgrade',
  'propagate-fix',
  'chat',
  'tests',
] as const satisfies readonly AgentTaskKind[]

const writeKinds: Record<AgentTaskKind, WriteTaskOptions['kind']> = {
  fix: 'fix',
  port: 'port',
  upgrade: 'change',
  'propagate-fix': 'fix',
  chat: 'change',
  tests: 'tests',
}

/**
 * Why a task operation was refused; `status` is the HTTP status routes answer with. A 403 carries
 * the missing permission, with the repository key as the caller passed it.
 */
export class TaskError extends Error {
  override name = 'TaskError'
  readonly status: 400 | 403 | 404 | 409
  readonly missing?: ForbiddenError['missing']

  constructor(status: 400 | 404 | 409, message: string)
  constructor(status: 403, message: string, missing: ForbiddenError['missing'])
  constructor(status: 400 | 403 | 404 | 409, message: string, missing?: ForbiddenError['missing']) {
    super(message)
    this.status = status
    this.missing = missing
  }
}

const sourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('dependency-upgrade'),
    ecosystem: z.string().min(1),
    package: z.string().min(1),
    from: z.string().optional(),
    to: z.string().min(1),
  }),
  z.object({ type: z.literal('propagate'), group: z.string().optional() }),
  z.object({ type: z.literal('mcp'), client: z.string().optional() }),
  z.object({ type: z.literal('api') }),
])

/** A request to change code in one or more repositories (`AgentTaskGroupInput`). */
export const taskGroupRequestSchema = z.object({
  kind: z.enum(agentTaskKinds).default('fix'),
  title: z.string().trim().min(1).max(200),
  prompt: z.string().max(20_000).optional(),
  plan: z.string().max(20_000).optional(),
  patch: z.string().max(1_000_000).optional(),
  repos: z.array(z.string().min(3)).min(1).max(50),
  run: z.boolean().optional(),
  source: sourceSchema.optional(),
})

export type TaskGroupRequest = z.input<typeof taskGroupRequestSchema>

/** What the task service reads and writes. */
export type TaskDeps = Pick<ServerDeps, 'store' | 'config' | 'now'> & {
  readOnly?: ReadOnlyRepos
}

const shortId = (prefix: string) =>
  `${prefix}${crypto.randomUUID().replaceAll('-', '').slice(0, 7)}`

const parseKey = (key: string): RepoRef | undefined => {
  const separator = key.indexOf(':')
  return separator > 0 && separator < key.length - 1
    ? { forge: key.slice(0, separator), path: key.slice(separator + 1) }
    : undefined
}

const interactiveTriggers: readonly JobTrigger[] = ['manual', 'command']

/**
 * Whether the principal may see `repo` well enough to propose a change there: `repos:read`, or
 * its catalog facts (another team's repository under `access.crossTeam`).
 */
async function canSeeTaskRepo(deps: TaskDeps, principal: Principal, target: RepoTarget) {
  if (can(principal, 'repos:read', { kind: 'repo', repo: target })) return true
  return canSeeCatalog(principal, target, await crossTeamPolicy(deps.store.settings))
}

/**
 * Whether the principal may have Holtkeeper change `repo`: `tasks:run` on it, and either
 * `repos:read` (its own team) or catalog reach (another team's repository, where the `tasks:run`
 * grant must name it explicitly, since a team grant never covers other teams).
 */
async function canRunTask(deps: TaskDeps, principal: Principal, target: RepoTarget) {
  if (!can(principal, 'tasks:run', { kind: 'repo', repo: target })) return false
  return canSeeTaskRepo(deps, principal, target)
}

const targetOf = (deps: TaskDeps, key: string): RepoTarget => {
  const repo = parseKey(key)
  if (!repo || !deps.config.forges[repo.forge])
    throw new TaskError(400, `unknown repository ${key}`)
  return repoTarget(deps.config, repo)
}

/** The task's branch: `holtkeeper/<group id>-<slug>`, shared by every repository of the group. */
const branchOf = (task: Pick<AgentTask, 'groupId' | 'title'>) =>
  taskBranch(task.groupId, task.title)

const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/

/**
 * Files, added and removed lines of a unified diff (`git diff` output, or one file's hunks as
 * forges return them; then `files` counts nothing). Hunk line counts decide where a hunk ends, so
 * content lines that look like headers are counted as content.
 */
export function diffstatOf(patch: string): AgentTaskDiffstat {
  const stat = { files: 0, additions: 0, deletions: 0 }
  let oldLeft = 0
  let newLeft = 0
  let gitHeader = false
  for (const line of patch.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith('+')) {
        stat.additions++
        newLeft--
      } else if (line.startsWith('-')) {
        stat.deletions++
        oldLeft--
      } else if (!line.startsWith('\\')) {
        oldLeft--
        newLeft--
      }
      continue
    }
    const hunk = HUNK.exec(line)
    if (hunk) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1])
      newLeft = hunk[2] === undefined ? 1 : Number(hunk[2])
    } else if (line.startsWith('diff --git ')) {
      stat.files++
      gitHeader = true
    } else if (line.startsWith('+++ ')) {
      if (!gitHeader) stat.files++
      gitHeader = false
    }
  }
  return stat
}

/** The size of a task's change: its merge request's when read, else the patch it carries. */
function taskDiffstat(task: AgentTask, groupPatch: string | undefined): AgentTaskView['diffstat'] {
  const read = task.mergeRequest?.diffstat
  if (read) return { ...read, source: 'merge-request' }
  const patch = task.patch ?? groupPatch
  return patch === undefined ? undefined : { ...diffstatOf(patch), source: 'patch' }
}

const taskView = (
  task: AgentTask,
  groupPatch: string | undefined,
  allowed: AgentTaskView['can'],
): AgentTaskView => {
  const { patch: _patch, ...rest } = task
  const diffstat = taskDiffstat(task, groupPatch)
  return {
    ...rest,
    branch: branchOf(task),
    ci: task.status === 'mr-open' ? (task.mergeRequest?.ci ?? 'pending') : 'none',
    ...(diffstat && { diffstat }),
    can: allowed,
  }
}

const retryableStatuses: ReadonlySet<AgentTaskStatus> = new Set(['failed', 'cancelled'])

const isActive = (task: Pick<AgentTask, 'status'>) =>
  !finalTaskStatuses.includes(task.status) && task.status !== 'mr-open'

const retryable = (task: Pick<AgentTask, 'status' | 'mergeRequest' | 'jobId'>) =>
  retryableStatuses.has(task.status) &&
  task.jobId !== undefined &&
  task.mergeRequest?.state !== 'open'

/** A group with its tasks, derived status and what `principal` may do with it. */
export async function groupView(
  deps: TaskDeps,
  principal: Principal | undefined,
  group: AgentTaskGroup,
  tasks?: AgentTask[],
): Promise<AgentTaskGroupView> {
  const members = tasks ?? (await deps.store.tasks.list({ groupIds: [group.id] }))
  const ordered = group.repos.flatMap((repo) => members.filter((task) => task.repo === repo))
  const extra = members.filter((task) => !group.repos.includes(task.repo))
  const all = [...ordered, ...extra]
  const status = agentGroupStatus(all)
  const { patch, ...rest } = group
  const runs = new Map<string, boolean>()
  const mayRun = async (repo: string) => {
    if (!principal) return false
    const known = runs.get(repo)
    if (known !== undefined) return known
    const allowed = await canRunTask(deps, principal, repoTarget(deps.config, parseKey(repo)!))
    runs.set(repo, allowed)
    return allowed
  }
  const proposed = all.filter((each) => each.status === 'proposed')
  let approvable = proposed.length > 0
  for (const task of proposed)
    // oxlint-disable-next-line no-await-in-loop -- few targets, settings are cached by the store
    if (!(await mayRun(task.repo))) approvable = false
  const mayCancel = (task: AgentTask) =>
    principal !== undefined &&
    (principal.id === group.proposedBy ||
      can(principal, 'tasks:run', {
        kind: 'repo',
        repo: repoTarget(deps.config, parseKey(task.repo)!),
      }))
  const views: AgentTaskView[] = []
  for (const task of all)
    views.push(
      taskView(task, patch, {
        retry:
          retryable(task) &&
          // oxlint-disable-next-line no-await-in-loop -- answers are cached per repository
          (await mayRun(task.repo)),
        cancel: isActive(task) && mayCancel(task),
      }),
    )
  const active = all.filter(isActive)
  const mayRetryAll = await Promise.all(
    all.filter(retryable).map(async (task) => mayRun(task.repo)),
  )
  return {
    ...rest,
    status,
    tasks: views,
    costUsd: Math.round(all.reduce((sum, task) => sum + (task.costUsd ?? 0), 0) * 10_000) / 10_000,
    hasPatch: patch !== undefined,
    can: {
      approve: approvable,
      cancel:
        principal !== undefined &&
        active.length > 0 &&
        (principal.id === group.proposedBy || all.every(mayCancel)),
      retry: mayRetryAll.length > 0 && mayRetryAll.every(Boolean),
      reject:
        status === 'proposed' &&
        principal !== undefined &&
        (principal.id === group.proposedBy || all.every(mayCancel)),
    },
  }
}

/** The group's spend cap: `perRepoUsd` per repository, within `perGroupUsd` in total. */
async function groupBudget(deps: TaskDeps, repos: number) {
  const settings = await tasksWriteSettings(deps.store)
  const perRepo =
    Math.floor(Math.min(settings.perRepoUsd, settings.perGroupUsd / repos) * 100) / 100
  return { settings, perRepo, total: Math.round(perRepo * repos * 100) / 100 }
}

/**
 * Proposes a change: a group with one `proposed` task per repository, all on the branch
 * `holtkeeper/<group id>-<slug>`. The principal must see every target (`repos:read`, or catalog
 * reach for other teams' repositories). With `run` it is approved right away (`approveTaskGroup`).
 * `trigger` decides the budget class: `manual` and `command` (a person asked) are interactive,
 * anything else automatic.
 */
export async function createTaskGroup(
  deps: TaskDeps,
  principal: Principal,
  input: TaskGroupRequest,
  options: { source?: AgentTaskSource; trigger?: JobTrigger } = {},
): Promise<AgentTaskGroupView> {
  const request = taskGroupRequestSchema.parse(input)
  if (!request.prompt?.trim() && !request.patch)
    throw new TaskError(400, 'a task needs a prompt or a patch')
  const keys = [...new Set(request.repos)]
  const { settings } = await groupBudget(deps, keys.length)
  if (keys.length > settings.maxRepos)
    throw new TaskError(400, `a task changes at most ${settings.maxRepos} repositories`)
  for (const key of keys) {
    const target = targetOf(deps, key)
    // oxlint-disable-next-line no-await-in-loop -- few targets, settings are cached by the store
    if (!(await canSeeTaskRepo(deps, principal, target)))
      throw new TaskError(403, `cannot see ${key}`, { action: 'repos:read', target: key })
    // oxlint-disable-next-line no-await-in-loop -- see above
    if (request.patch && !(await canRunTask(deps, principal, target)))
      throw new TaskError(403, `proposing a patch needs tasks:run on ${key}`, {
        action: 'tasks:run',
        target: key,
      })
  }

  const at = deps.now().toISOString()
  const trigger = options.trigger ?? 'manual'
  const source = options.source ?? request.source ?? { type: 'api' }
  const prompt = request.prompt?.trim() ?? ''
  const group: AgentTaskGroup = {
    id: shortId('g'),
    kind: request.kind,
    title: request.title,
    prompt,
    ...(request.plan?.trim() && { plan: request.plan.trim() }),
    ...(request.patch && { patch: request.patch }),
    proposedBy: principal.id,
    source,
    repos: keys,
    budgetClass: interactiveTriggers.includes(trigger) ? 'interactive' : 'automatic',
    createdAt: at,
    updatedAt: at,
  }
  await deps.store.tasks.putGroup(group)
  const tasks = keys.map((repo) => newTask(group, repo, principal.id, at))
  for (const task of tasks)
    // oxlint-disable-next-line no-await-in-loop -- tasks keep the given order
    await deps.store.tasks.put(task)
  if (request.run) return approveTaskGroup(deps, principal, group.id, trigger)
  return groupView(deps, principal, group, tasks)
}

const newTask = (
  group: AgentTaskGroup,
  repo: string,
  requester: string,
  at: string,
): AgentTask => ({
  id: shortId('t'),
  groupId: group.id,
  kind: group.kind,
  title: group.title,
  prompt: group.prompt,
  ...(group.plan && { plan: group.plan }),
  ...(group.patch && { patch: group.patch }),
  repo,
  requester,
  source: group.source,
  status: 'proposed',
  createdAt: at,
  updatedAt: at,
})

/** Who proposes the fix tasks of a package rollout. */
const PROPAGATE_PROPOSER = 'analyzer:propagate'

/**
 * Proposes the fix tasks of one `propagate` run: a `propagate-fix` group (source `propagate`,
 * automatic budget) with one `proposed` task per repository, each carrying its own prompt and the
 * bump as its patch. Unknown repositories are left out, and at most `maxRepos` are proposed.
 * Nothing is proposed while `tasks.write` is off, so the rollout opens its drafts instead.
 * People approve the group like any other (`approveTaskGroup`); nothing runs before that.
 */
export async function proposePropagateFixes(
  deps: TaskDeps,
  input: Parameters<FixProposer['propose']>[0],
): Promise<{ groupId: string; tasks: Record<string, string> } | undefined> {
  const { settings } = await groupBudget(deps, Math.max(1, input.fixes.length))
  if (!settings.enabled) return undefined
  const fixes = input.fixes
    .filter((fix) => {
      const repo = parseKey(fix.repo)
      return repo !== undefined && deps.config.forges[repo.forge] !== undefined
    })
    .slice(0, settings.maxRepos)
  if (fixes.length === 0) return undefined
  const at = deps.now().toISOString()
  const group: AgentTaskGroup = {
    id: shortId('g'),
    kind: 'propagate-fix',
    title: input.title.slice(0, 200),
    prompt: `Make the checks of the ${input.group} repositories pass after the dependency update.`,
    proposedBy: PROPAGATE_PROPOSER,
    source: { type: 'propagate', group: input.group },
    repos: fixes.map((fix) => fix.repo),
    budgetClass: 'automatic',
    createdAt: at,
    updatedAt: at,
  }
  await deps.store.tasks.putGroup(group)
  const tasks: Record<string, string> = {}
  for (const fix of fixes) {
    const task = {
      ...newTask(group, fix.repo, PROPAGATE_PROPOSER, at),
      prompt: fix.prompt,
      patch: fix.patch,
    }
    // oxlint-disable-next-line no-await-in-loop -- tasks keep the given order
    await deps.store.tasks.put(task)
    tasks[fix.repo] = task.id
  }
  return { groupId: group.id, tasks }
}

async function loadGroup(deps: TaskDeps, id: string) {
  const group = await deps.store.tasks.getGroup(id)
  if (!group) throw new TaskError(404, 'no such task group')
  return { group, tasks: await deps.store.tasks.list({ groupIds: [id] }) }
}

const holdingStatuses: readonly AgentTaskStatus[] = ['approved', 'queued', 'running']

/** Spend caps that approved, queued and running write tasks still hold, in USD. */
async function reservedWriteBudget(deps: TaskDeps, except: ReadonlySet<string>) {
  const holding = await deps.store.tasks.list({ status: [...holdingStatuses] })
  return holding.reduce((sum, task) => sum + (except.has(task.id) ? 0 : (task.budgetUsd ?? 0)), 0)
}

const usd = (value: number) => `$${value.toFixed(2)}`

/**
 * Refuses running `pending` (tasks of `group`, whose tasks are `all`) for `principal` while
 * `tasks.write` is off, without `tasks:run` on a target (`canRunTask`), for read-only
 * repositories, once the group's tasks spent or hold `perGroupUsd`, and when this week's write
 * task spend plus the caps other tasks hold plus these caps would pass `weeklyUsd`. Returns each
 * pending task's spend cap: `perRepoUsd`, split within what is left of the group's cap.
 */
async function assertMayRun(
  deps: TaskDeps,
  principal: Principal,
  group: AgentTaskGroup,
  all: readonly AgentTask[],
  pending: readonly AgentTask[],
): Promise<number> {
  const settings = await tasksWriteSettings(deps.store)
  if (!settings.enabled)
    throw new TaskError(409, 'write tasks are turned off (setting tasks.write)')
  for (const task of pending) {
    const target = targetOf(deps, task.repo)
    // oxlint-disable-next-line no-await-in-loop -- few targets, settings are cached by the store
    if (!(await canRunTask(deps, principal, target)))
      throw new TaskError(403, `missing tasks:run on ${task.repo}`, {
        action: 'tasks:run',
        target: task.repo,
      })
    // oxlint-disable-next-line no-await-in-loop -- see above
    if (await deps.readOnly?.(target))
      throw new TaskError(409, `${task.repo} is read-only for Holtkeeper`)
  }
  const ids = new Set(pending.map((task) => task.id))
  const committed = all.reduce(
    (sum, task) =>
      sum +
      (task.costUsd ?? 0) +
      (!ids.has(task.id) && holdingStatuses.includes(task.status) ? (task.budgetUsd ?? 0) : 0),
    0,
  )
  const repos = Math.max(group.repos.length, all.length, 1)
  const perRepo =
    Math.floor(
      Math.min(
        settings.perRepoUsd,
        settings.perGroupUsd / repos,
        (settings.perGroupUsd - committed) / pending.length,
      ) * 100,
    ) / 100
  if (perRepo <= 0)
    throw new TaskError(
      409,
      `this task group used its spend cap of ${usd(settings.perGroupUsd)} (${usd(committed)} spent or held)`,
    )
  const spent = await weeklyWriteSpend(deps)
  const held = await reservedWriteBudget(deps, ids)
  const wanted = perRepo * pending.length
  if (spent + held + wanted > settings.weeklyUsd)
    throw new TaskError(
      409,
      `write tasks spent ${usd(spent)} and hold ${usd(held)} of ${usd(settings.weeklyUsd)} this week; this needs ${usd(wanted)} more`,
    )
  return perRepo
}

/**
 * Starts `tasks` of `group` for `principal`: each task still in a `from` status is approved with
 * `budgetUsd` (atomically, so a second approval of the same task does nothing), its `write-task`
 * job is queued and the task marked `queued` with the job. Returns how many started.
 */
async function startTasks(
  deps: TaskDeps,
  principal: Principal,
  group: AgentTaskGroup,
  tasks: readonly AgentTask[],
  from: readonly AgentTaskStatus[],
  budgetUsd: number,
  trigger: JobTrigger,
): Promise<number> {
  let started = 0
  for (const task of tasks) {
    const { error: _error, ...rest } = task
    const approved: AgentTask = {
      ...rest,
      requester: principal.id,
      status: 'approved',
      budgetUsd,
      updatedAt: deps.now().toISOString(),
    }
    // oxlint-disable-next-line no-await-in-loop -- jobs keep the given order
    if (!(await deps.store.tasks.transition(approved, from))) continue
    // oxlint-disable-next-line no-await-in-loop -- see above
    const job = await deps.store.jobs.enqueue({
      analyzer: WRITE_TASK_KIND,
      repo: targetOf(deps, task.repo),
      options: writeTaskOptionsSchema.parse({
        taskId: group.id,
        task: task.id,
        title: task.title,
        kind: writeKinds[task.kind],
        budgetUsd,
        ...(task.prompt && { prompt: [task.prompt, task.plan].filter(Boolean).join('\n\n') }),
        ...(!task.prompt && task.plan && { prompt: task.plan }),
        ...(task.patch && { patch: task.patch }),
        ...(group.repos.length > 1 && { group: group.id }),
      }),
      trigger,
      maxAttempts: 1,
      createdAt: deps.now().toISOString(),
      actor: principal.id,
      reason: `task ${group.id}: ${task.title}`,
    })
    const queued: AgentTask = { ...approved, status: 'queued', jobId: job.id }
    // oxlint-disable-next-line no-await-in-loop -- see above
    if (!(await deps.store.tasks.transition(queued, ['approved']))) {
      // oxlint-disable-next-line no-await-in-loop -- see above
      const current = await deps.store.tasks.get(task.id)
      // oxlint-disable-next-line no-await-in-loop -- see above
      if (current?.status === 'cancelled') await deps.store.jobs.cancel(job.id, queued.updatedAt)
    }
    started++
  }
  return started
}

const jobTriggerOf = (group: AgentTaskGroup, trigger: JobTrigger): JobTrigger =>
  group.budgetClass === 'interactive' ? trigger : 'schedule'

/**
 * Approves every `proposed` task of the group for `principal` and queues a `write-task` job per
 * repository (one attempt each, on a write worker). Refuses while `tasks.write` is off, when the
 * principal may not run tasks on a target (`canRunTask`), for read-only repositories and once
 * this week's write task spend reached `weeklyUsd`. The approver becomes every task's requester;
 * `manual` and `command` triggers make the runs interactive budget work.
 */
export async function approveTaskGroup(
  deps: TaskDeps,
  principal: Principal,
  groupId: string,
  trigger: JobTrigger = 'manual',
): Promise<AgentTaskGroupView> {
  const { group, tasks } = await loadGroup(deps, groupId)
  const pending = tasks.filter((task) => task.status === 'proposed')
  if (pending.length === 0)
    throw new TaskError(409, 'nothing in this task group waits for approval')
  const perRepo = await assertMayRun(deps, principal, group, tasks, pending)

  const at = deps.now().toISOString()
  const interactive = interactiveTriggers.includes(trigger)
  const approved: AgentTaskGroup = {
    ...group,
    approvedBy: principal.id,
    approvedAt: at,
    budgetClass: interactive ? 'interactive' : group.budgetClass,
    updatedAt: at,
  }
  const started = await startTasks(
    deps,
    principal,
    approved,
    pending,
    ['proposed'],
    perRepo,
    jobTriggerOf(approved, trigger),
  )
  if (started === 0) throw new TaskError(409, 'nothing in this task group waits for approval')
  await deps.store.tasks.putGroup(approved)
  const view = await groupView(deps, principal, approved)
  await syncTaskCard(deps, view)
  return view
}

/**
 * Runs a `failed` or `cancelled` task again on the same branch, as a new job for `principal`,
 * under the same checks as approving (`tasks.write`, `tasks:run`, read-only, weekly spend). A
 * task whose merge request is still open is refused; people work on that one in the forge. A task
 * that never ran (cancelled or rejected before approval) is refused too: retrying is no approval.
 */
export async function retryTask(
  deps: TaskDeps,
  principal: Principal,
  taskId: string,
  trigger: JobTrigger = 'manual',
): Promise<AgentTaskGroupView> {
  const task = await deps.store.tasks.get(taskId)
  if (!task) throw new TaskError(404, 'no such task')
  const { group, tasks } = await loadGroup(deps, task.groupId)
  if (!retryable(task)) throw new TaskError(409, `a ${task.status} task cannot run again`)
  const perRepo = await assertMayRun(deps, principal, group, tasks, [task])
  const at = deps.now().toISOString()
  const updated: AgentTaskGroup = {
    ...group,
    ...(interactiveTriggers.includes(trigger) && { budgetClass: 'interactive' as const }),
    updatedAt: at,
  }
  const started = await startTasks(
    deps,
    principal,
    updated,
    [task],
    [...retryableStatuses],
    perRepo,
    jobTriggerOf(updated, trigger),
  )
  if (started === 0) throw new TaskError(409, 'the task changed meanwhile; reload it')
  await deps.store.tasks.putGroup(updated)
  const view = await groupView(deps, principal, updated)
  await syncTaskCard(deps, view)
  return view
}

/**
 * Runs every `failed` or `cancelled` task of the group again (those that ran once and have no
 * open merge request), as new jobs for `principal`, under the same checks as `retryTask` for all of them at
 * once: a refusal on any target retries none.
 */
export async function retryTaskGroup(
  deps: TaskDeps,
  principal: Principal,
  groupId: string,
  trigger: JobTrigger = 'manual',
): Promise<AgentTaskGroupView> {
  const { group, tasks } = await loadGroup(deps, groupId)
  const pending = tasks.filter(retryable)
  if (pending.length === 0) throw new TaskError(409, 'nothing in this task group can run again')
  const perRepo = await assertMayRun(deps, principal, group, tasks, pending)
  const updated: AgentTaskGroup = {
    ...group,
    ...(interactiveTriggers.includes(trigger) && { budgetClass: 'interactive' as const }),
    updatedAt: deps.now().toISOString(),
  }
  const started = await startTasks(
    deps,
    principal,
    updated,
    pending,
    [...retryableStatuses],
    perRepo,
    jobTriggerOf(updated, trigger),
  )
  if (started === 0) throw new TaskError(409, 'the task group changed meanwhile; reload it')
  await deps.store.tasks.putGroup(updated)
  const view = await groupView(deps, principal, updated)
  await syncTaskCard(deps, view)
  return view
}

/**
 * Rejects a group that still waits for approval: cancels it as `cancelTaskGroup` does, with the
 * same permissions. A group that is no longer `proposed` is refused.
 */
export async function rejectTaskGroup(
  deps: TaskDeps,
  principal: Principal,
  groupId: string,
): Promise<AgentTaskGroupView> {
  const { tasks } = await loadGroup(deps, groupId)
  if (agentGroupStatus(tasks) !== 'proposed')
    throw new TaskError(409, 'only a proposed task group can be rejected')
  return cancelTaskGroup(deps, principal, groupId)
}

/**
 * How many task groups `principal` sees (`canSeeGroup`) that wait for approval: any task still
 * `proposed`. Reads only proposed tasks and their groups.
 */
export async function countGroupsAwaitingApproval(
  deps: Pick<TaskDeps, 'store' | 'config'>,
  principal: Principal,
): Promise<number> {
  const proposed = await deps.store.tasks.list({ status: ['proposed'] })
  const groups = await Promise.all(
    [...new Set(proposed.map((task) => task.groupId))].map((id) => deps.store.tasks.getGroup(id)),
  )
  return groups.filter((group) => group && canSeeGroup(deps, principal, group)).length
}

/**
 * Cancels the tasks of the group that have not opened a merge request or ended (only `taskId`
 * when given), and their queued or running jobs. The proposer may cancel their own group; anyone
 * else needs `tasks:run` on every target (on the one task's repository for a single task). Open
 * merge requests stay; people close them on the forge.
 */
export async function cancelTaskGroup(
  deps: TaskDeps,
  principal: Principal,
  groupId: string,
  taskId?: string,
): Promise<AgentTaskGroupView> {
  const { group, tasks } = await loadGroup(deps, groupId)
  const before = await groupView(deps, principal, group, tasks)
  const chosen = taskId ? before.tasks.filter((task) => task.id === taskId) : before.tasks
  if (taskId && chosen.length === 0) throw new TaskError(404, 'no such task')
  const allowed = taskId ? chosen.every((task) => task.can.cancel) : before.can.cancel
  if (!allowed) {
    const active = chosen.some(isActive)
    if (!active) throw new TaskError(409, 'nothing to cancel')
    throw new TaskError(403, 'missing tasks:run', { action: 'tasks:run' })
  }
  const ids = new Set(chosen.map((task) => task.id))
  const at = deps.now().toISOString()
  for (const task of tasks) {
    if (!isActive(task) || !ids.has(task.id)) continue
    // oxlint-disable-next-line no-await-in-loop -- one task after another
    if (task.jobId) await deps.store.jobs.cancel(task.jobId, at)
    // oxlint-disable-next-line no-await-in-loop -- see above
    await deps.store.tasks.put({
      ...task,
      status: 'cancelled',
      error: `cancelled by ${principal.name}`,
      updatedAt: at,
    })
  }
  const cancelled = { ...group, ...(!taskId && { cancelledBy: principal.id }), updatedAt: at }
  await deps.store.tasks.putGroup(cancelled)
  const view = await groupView(deps, principal, cancelled)
  await syncTaskCard(deps, view)
  return view
}

const mergeRequestsOf = (view: AgentTaskGroupView): TaskCardMergeRequest[] =>
  view.tasks.flatMap((task) =>
    task.mergeRequest
      ? [
          {
            repo: task.repo,
            id: task.mergeRequest.id,
            url: task.mergeRequest.url,
            draft: task.mergeRequest.draft,
          },
        ]
      : [],
  )

const stepsOf = (view: AgentTaskGroupView) =>
  taskSteps(
    view.repos.flatMap((repo) => {
      const task = view.tasks.find((each) => each.repo === repo)
      if (!task) return []
      return [
        {
          repo,
          status: task.status,
          ...(task.error && { error: task.error }),
          ...(task.mergeRequest && {
            mergeRequest: {
              id: task.mergeRequest.id,
              url: task.mergeRequest.url,
              draft: task.mergeRequest.draft,
            },
          }),
        },
      ]
    }),
  )

/** What a group's chat card refers to: the task group and each of its repositories. */
const cardRefs = (view: AgentTaskGroupView): ChatMessageRef[] => [
  { kind: 'task', id: view.id },
  ...view.repos.map((repo) => ({ kind: 'repo' as const, repo })),
]

/**
 * Rewrites the chat card of a group that came from a chat thread with its current state: status,
 * a step per repository and merge requests; the message's refs follow the group's repositories.
 */
async function syncTaskCard(deps: Pick<TaskDeps, 'store' | 'now'>, view: AgentTaskGroupView) {
  if (view.source.type !== 'chat' || !view.source.messageId) return
  const message = await deps.store.chat.getMessage(view.source.messageId)
  if (!message || message.threadId !== view.source.threadId) return
  const block = message.card?.blocks.find((each) => each.type === 'task')
  if (!block || block.type !== 'task' || (block.groupId && block.groupId !== view.id)) return
  await deps.store.chat.updateMessage(message.id, {
    card: taskCard(view.repos, block.summary, {
      status: view.status,
      groupId: view.id,
      ...(block.budgetUsd !== undefined && { budgetUsd: block.budgetUsd }),
      mergeRequests: mergeRequestsOf(view),
      steps: stepsOf(view),
    }),
    refs: cardRefs(view),
    updatedAt: deps.now().toISOString(),
  })
}

/** Posts `body` with `refs` in the chat thread a group came from, as Holtkeeper. */
async function postInThread(
  deps: Pick<TaskDeps, 'store' | 'now'>,
  group: AgentTaskGroup,
  body: string,
  refs: ChatMessageRef[],
) {
  if (group.source.type !== 'chat') return
  if (!(await deps.store.chat.getThread(group.source.threadId))) return
  await deps.store.chat.addMessage({
    id: crypto.randomUUID(),
    threadId: group.source.threadId,
    createdAt: deps.now().toISOString(),
    authorType: 'system',
    body,
    mentions: [],
    refs,
  })
}

/**
 * Posts a proposal card for a new group in the thread it came from, with a step per repository
 * and refs to the group and its repositories, and remembers the card's message, so later status
 * changes update the card in place.
 */
export async function postTaskCard(
  deps: Pick<TaskDeps, 'store' | 'now'>,
  view: AgentTaskGroupView,
  summary: string,
  budgetUsd?: number,
): Promise<void> {
  if (view.source.type !== 'chat') return
  const message = await deps.store.chat.addMessage({
    id: crypto.randomUUID(),
    threadId: view.source.threadId,
    createdAt: deps.now().toISOString(),
    authorType: 'agent',
    body: '',
    mentions: [],
    card: taskCard(view.repos, summary, {
      status: view.status,
      groupId: view.id,
      ...(budgetUsd !== undefined && { budgetUsd }),
      steps: stepsOf(view),
    }),
    refs: cardRefs(view),
  })
  const group = await deps.store.tasks.getGroup(view.id)
  if (group)
    await deps.store.tasks.putGroup({
      ...group,
      source: { ...view.source, messageId: message.id },
    })
}

/** The group's spend cap for a proposal card. */
export const proposalBudget = async (deps: TaskDeps, repos: number) =>
  (await groupBudget(deps, repos)).total

async function updateTask(
  deps: Pick<TaskDeps, 'store' | 'now'>,
  taskId: string,
  change: (task: AgentTask) => AgentTask | undefined,
): Promise<{ task: AgentTask; group: AgentTaskGroup } | undefined> {
  const task = await deps.store.tasks.get(taskId)
  if (!task) return undefined
  const next = change(task)
  if (!next) return undefined
  await deps.store.tasks.put({ ...next, updatedAt: deps.now().toISOString() })
  const group = await deps.store.tasks.getGroup(task.groupId)
  if (!group) return undefined
  await deps.store.tasks.putGroup({ ...group, updatedAt: deps.now().toISOString() })
  return { task: next, group }
}

const refuse = (why: string): never => {
  throw new WriteTaskRefusedError(`not started: ${why}`)
}

/**
 * Claims the stored task of a write task job when it starts on a worker and marks it `running`.
 * Refuses (`WriteTaskRefusedError`) jobs that no approved task queued: no task, a task of another
 * repository or group, one another job carries out, or one that is no longer approved or queued.
 */
export async function taskStarted(
  deps: Pick<TaskDeps, 'store' | 'now' | 'config'>,
  repo: RepoRef,
  options: Pick<WriteTaskOptions, 'task' | 'taskId'>,
  jobId: string | undefined,
): Promise<void> {
  if (!options.task) return refuse('write tasks run only for approved task groups')
  const task = await deps.store.tasks.get(options.task)
  if (!task || task.repo !== repoKey(repo) || task.groupId !== options.taskId)
    return refuse('the job does not match its task')
  const ours = task.jobId === undefined ? task.status === 'approved' : task.jobId === jobId
  if (!ours) return refuse('another job carries out this task')
  const running: AgentTask = {
    ...task,
    status: 'running',
    ...(jobId !== undefined && { jobId }),
    updatedAt: deps.now().toISOString(),
  }
  if (!(await deps.store.tasks.transition(running, ['approved', 'queued'])))
    return refuse(`the task is ${task.status}`)
  const group = await deps.store.tasks.getGroup(task.groupId)
  if (!group) return
  const touched = { ...group, updatedAt: deps.now().toISOString() }
  await deps.store.tasks.putGroup(touched)
  await syncTaskCard(deps, await groupView(deps, undefined, touched))
}

const outcomeOf = (
  job: Job,
  data: WriteTaskData | undefined,
): Pick<AgentTask, 'status'> & Partial<AgentTask> => {
  if (job.status === 'canceled') return { status: 'cancelled', error: 'the job was cancelled' }
  if (job.status !== 'succeeded' || !data)
    return { status: 'failed', error: job.error ?? `the job ended ${job.status}` }
  const agent = data.agent
  const spent = {
    ...(agent?.transcriptRef !== undefined && { transcriptRef: agent.transcriptRef }),
  }
  if (data.status === 'opened' && data.mergeRequest)
    return {
      status: 'mr-open',
      ...spent,
      mergeRequest: { ...data.mergeRequest, state: 'open', ci: 'pending' },
    }
  return {
    status: 'done',
    ...spent,
    ...(data.status === 'dry-run' && { error: 'dry run: nothing was pushed' }),
  }
}

/** What one job's agent runs cost: its usage records, else the cost the run reported. */
async function jobCost(
  deps: Pick<TaskDeps, 'store'>,
  job: Job,
  data: WriteTaskData | undefined,
): Promise<number> {
  const [recorded] = await deps.store.aiUsage.aggregate({ filter: { jobId: job.id } })
  return recorded?.costUsd || (data?.agent?.costUsd ?? 0)
}

/**
 * Records how a `write-task` job ended on its task: `mr-open` with the merge request, `done`
 * when there was nothing to change, `failed` or `cancelled` otherwise, with the transcript. The
 * job's cost (its usage records, whatever the outcome) is added to what earlier runs of the task
 * spent. A chat card of the group is updated in place and a new merge request is linked in its
 * thread. Jobs of other analyzers, jobs without a task and jobs the task no longer runs are
 * ignored.
 */
export async function taskJobFinished(
  deps: Pick<TaskDeps, 'store' | 'now' | 'config'>,
  job: Job,
  record?: AnalysisRecord,
): Promise<void> {
  if (job.analyzer !== WRITE_TASK_KIND) return
  const parsed = writeTaskOptionsSchema.safeParse(job.options)
  if (!parsed.success || !parsed.data.task) return
  const stored =
    record?.kind === WRITE_TASK_KIND ? writeTaskDataSchema.safeParse(record.data) : undefined
  const data = stored?.success ? stored.data : undefined
  const outcome = outcomeOf(job, data)
  const cost = await jobCost(deps, job, data)
  const updated = await updateTask(deps, parsed.data.task, (task) =>
    finalTaskStatuses.includes(task.status) || (task.jobId !== undefined && task.jobId !== job.id)
      ? undefined
      : {
          ...task,
          ...outcome,
          ...(cost > 0 && { costUsd: Math.round(((task.costUsd ?? 0) + cost) * 10_000) / 10_000 }),
        },
  )
  if (!updated) return
  const view = await groupView(deps, undefined, updated.group)
  await syncTaskCard(deps, view)
  const mr = updated.task.mergeRequest
  if (outcome.status === 'mr-open' && mr)
    await postInThread(
      deps,
      updated.group,
      `Opened ${mr.draft ? 'draft ' : ''}merge request [!${mr.id}](${mr.url}) in \`${updated.task.repo}\`.`,
      [
        { kind: 'mr', repo: updated.task.repo, iid: mr.id },
        { kind: 'task', id: updated.group.id, repo: updated.task.repo },
      ],
    )
  else if (outcome.status === 'failed')
    await postInThread(
      deps,
      updated.group,
      `The change in \`${updated.task.repo}\` failed: ${outcome.error ?? 'unknown error'}`,
      [{ kind: 'task', id: updated.group.id, repo: updated.task.repo }],
    )
}

const ciOf = (status: string | undefined): AgentTaskCi => {
  switch (status) {
    case undefined:
      return 'none'
    case 'success':
      return 'success'
    case 'failed':
      return 'failed'
    case 'canceled':
    case 'skipped':
      return 'canceled'
    case 'running':
      return 'running'
    default:
      return 'pending'
  }
}

/** The size of a merge request from the files the forge lists. */
const forgeDiffstat = (files: readonly { diff: string }[]): AgentTaskDiffstat => {
  const lines = files.map((file) => diffstatOf(file.diff))
  return {
    files: files.length,
    additions: lines.reduce((sum, each) => sum + each.additions, 0),
    deletions: lines.reduce((sum, each) => sum + each.deletions, 0),
  }
}

/** How long merge request state and CI are trusted before the forge is asked again. */
const MERGE_REQUEST_CHECK_MS = 60_000

/**
 * Reads state and CI of the open merge requests of the group's tasks from the forge, at most once
 * per `MERGE_REQUEST_CHECK_MS` each, and their diffstat whenever the head commit moved: a merged
 * one makes its task `done`, a closed one `cancelled`. Forge failures leave the task as it was.
 */
export async function refreshTaskGroup(deps: TaskDeps, groupId: string): Promise<void> {
  const { group, tasks } = await loadGroup(deps, groupId)
  const now = deps.now().getTime()
  let changed = false
  for (const task of tasks) {
    const mr = task.mergeRequest
    if (task.status !== 'mr-open' || !mr) continue
    if (mr.checkedAt && now - Date.parse(mr.checkedAt) < MERGE_REQUEST_CHECK_MS) continue
    const repo = parseKey(task.repo)
    if (!repo) continue
    try {
      const forge = forgeFor(deps.config, repo.forge)
      // oxlint-disable-next-line no-await-in-loop -- few open merge requests per group
      const current = await forge.getMergeRequest?.(repo.path, mr.id)
      // oxlint-disable-next-line no-await-in-loop -- see above
      const [pipeline] = await forge.listPipelines(repo.path, { ref: branchOf(task) })
      const state = current?.state ?? mr.state ?? 'open'
      const status: AgentTaskStatus =
        state === 'merged' ? 'done' : state === 'closed' ? 'cancelled' : 'mr-open'
      const stale = current?.headSha !== undefined && current.headSha !== mr.diffSha
      // oxlint-disable-next-line no-await-in-loop -- see above
      const diff = stale ? await forge.getMergeRequestDiff?.(repo.path, mr.id) : undefined
      // oxlint-disable-next-line no-await-in-loop -- see above
      await deps.store.tasks.put({
        ...task,
        status,
        mergeRequest: {
          ...mr,
          state,
          ...(current && { draft: current.draft }),
          ci: ciOf(pipeline?.status),
          checkedAt: deps.now().toISOString(),
          ...(diff && current && { diffstat: forgeDiffstat(diff.files), diffSha: current.headSha }),
        },
        ...(state === 'closed' && { error: 'the merge request was closed' }),
        updatedAt: deps.now().toISOString(),
      })
      changed ||= status !== task.status
    } catch {
      continue
    }
  }
  if (changed) {
    const updated = { ...group, updatedAt: deps.now().toISOString() }
    await deps.store.tasks.putGroup(updated)
    await syncTaskCard(deps, await groupView(deps, undefined, updated))
  }
}

/**
 * Repositories related to a write task's repository, for its agent: the other targets of its
 * group, members of its family and repositories sharing a config group that Holtkeeper has run
 * jobs on. At most 50.
 */
export async function relatedRepos(
  deps: Pick<TaskDeps, 'store' | 'config'>,
  repo: RepoRef,
  options: Pick<WriteTaskOptions, 'task'>,
): Promise<RelatedRepo[]> {
  const own = repoKey(repo)
  const found = new Map<string, string>()
  const task = options.task ? await deps.store.tasks.get(options.task) : undefined
  const group = task ? await deps.store.tasks.getGroup(task.groupId) : undefined
  for (const other of group?.repos ?? []) if (other !== own) found.set(other, 'in this task')
  for (const family of await deps.store.families.list())
    if (family.members.includes(own))
      for (const member of family.members)
        if (member !== own && !found.has(member)) found.set(member, `same family ${family.name}`)
  const groups = repoTarget(deps.config, repo).groups
  if (groups.length)
    for (const target of await deps.store.jobs.targets()) {
      if (target.group) continue
      const key = repoKey(target.repo)
      if (key === own || found.has(key)) continue
      const shared = repoTarget(deps.config, target.repo).groups.find((name) =>
        groups.includes(name),
      )
      if (shared) found.set(key, `same group ${shared}`)
    }
  return [...found].slice(0, 50).map(([key, relation]) => ({ repo: key, relation }))
}

/**
 * Records that a write task's agent asks to add `target` to its group; a person decides in the
 * panel (`decideRepoRequest`). Repeated requests for the same repository are ignored.
 */
export async function requestRepository(
  deps: Pick<TaskDeps, 'store' | 'config' | 'now'>,
  input: { options: Pick<WriteTaskOptions, 'task'>; target: string; reason: string },
): Promise<string> {
  const task = input.options.task ? await deps.store.tasks.get(input.options.task) : undefined
  const group = task ? await deps.store.tasks.getGroup(task.groupId) : undefined
  if (!task || !group) return 'This run belongs to no task, so it cannot ask for repositories.'
  const repo = parseKey(input.target)
  if (!repo || !deps.config.forges[repo.forge])
    return `${input.target} is not a configured forge:path.`
  if (group.repos.includes(input.target)) return `${input.target} is already part of this task.`
  if (group.requests?.some((request) => request.repo === input.target))
    return `${input.target} was already requested.`
  const at = deps.now().toISOString()
  await deps.store.tasks.putGroup({
    ...group,
    requests: [
      ...(group.requests ?? []),
      { repo: input.target, reason: input.reason, taskId: task.id, status: 'pending', at },
    ],
    updatedAt: at,
  })
  await postInThread(
    deps,
    group,
    `The change in \`${task.repo}\` asks to also change \`${input.target}\`: ${input.reason}`,
    [
      { kind: 'task', id: group.id, repo: task.repo },
      { kind: 'repo', repo: input.target },
    ],
  )
  return `Asked people to add ${input.target}. It is not part of this run; continue with this repository.`
}

/**
 * Approves or rejects a repository a task asked for. Approving adds a `proposed` task for it to
 * the group and, when the group was already approved, approves that task at once (the decider
 * needs `tasks:run` there). Rejecting needs the same permission or being the proposer.
 */
export async function decideRepoRequest(
  deps: TaskDeps,
  principal: Principal,
  groupId: string,
  repo: string,
  approve: boolean,
): Promise<AgentTaskGroupView> {
  const { group } = await loadGroup(deps, groupId)
  const request = group.requests?.find((each) => each.repo === repo && each.status === 'pending')
  if (!request) throw new TaskError(404, 'no pending request for that repository')
  const target = targetOf(deps, repo)
  if (
    !(await canRunTask(deps, principal, target)) &&
    !(principal.id === group.proposedBy && !approve)
  )
    throw new TaskError(403, `missing tasks:run on ${repo}`, { action: 'tasks:run', target: repo })
  const at = deps.now().toISOString()
  const decided: AgentTaskGroup = {
    ...group,
    ...(approve && { repos: [...group.repos, repo] }),
    requests: (group.requests ?? []).map((each) =>
      each === request
        ? { ...each, status: approve ? 'approved' : 'rejected', decidedBy: principal.id }
        : each,
    ),
    updatedAt: at,
  }
  await deps.store.tasks.putGroup(decided)
  if (!approve) return groupView(deps, principal, decided)
  await deps.store.tasks.put(newTask(decided, repo, principal.id, at))
  if (decided.approvedBy) return approveTaskGroup(deps, principal, groupId)
  const view = await groupView(deps, principal, decided)
  await syncTaskCard(deps, view)
  return view
}

/**
 * Whether the principal sees a group: they proposed or approved it, or may read one of its target
 * repositories (`repos:read`; catalog reach of other teams does not cover their tasks).
 */
export function canSeeGroup(
  deps: Pick<TaskDeps, 'config'>,
  principal: Principal,
  group: Pick<AgentTaskGroup, 'repos' | 'proposedBy' | 'approvedBy'>,
): boolean {
  if (group.proposedBy === principal.id || group.approvedBy === principal.id) return true
  return group.repos.some((key) => {
    const repo = parseKey(key)
    return (
      repo !== undefined &&
      deps.config.forges[repo.forge] !== undefined &&
      can(principal, 'repos:read', { kind: 'repo', repo: repoTarget(deps.config, repo) })
    )
  })
}

/** The group of a group id or of a task id, when `principal` may see it (`canSeeGroup`). */
async function findGroup(deps: TaskDeps, principal: Principal, id: string) {
  const task = id.startsWith('g') ? undefined : await deps.store.tasks.get(id)
  const group = await deps.store.tasks.getGroup(task?.groupId ?? id)
  return group && canSeeGroup(deps, principal, group) ? { group, task } : undefined
}

/**
 * The `tasks` tools for one MCP caller. `start_task` proposes a group (source `mcp`) and, when
 * `mayRun` (a token with the `tasks` scope) and asked to run, approves it as a `command` (an
 * interactive run for the owner); refusals keep the proposal and say why. `request_review` queues
 * a `review` job for the merge request of one of the group's tasks and needs `tasks:run` on its
 * repository plus `mayRun`.
 */
export function taskToolsAccess(
  deps: TaskDeps,
  principal: Principal,
  options: { mayRun: boolean; client?: string },
): TaskToolsAccess {
  const status = async (id: string) => {
    const found = await findGroup(deps, principal, id)
    if (!found) return undefined
    await refreshTaskGroup(deps, found.group.id).catch(() => {})
    const current = (await deps.store.tasks.getGroup(found.group.id)) ?? found.group
    return groupView(deps, principal, current)
  }
  return {
    async start(input) {
      try {
        const proposed = await createTaskGroup(
          deps,
          principal,
          { kind: input.kind, title: input.title, prompt: input.prompt, repos: input.repos },
          {
            source: { type: 'mcp', ...(options.client && { client: options.client }) },
            trigger: 'command',
          },
        )
        if (!input.run) return { group: proposed, started: false }
        if (!options.mayRun)
          return {
            group: proposed,
            started: false,
            reason: 'this token cannot run tasks (needs the tasks scope)',
          }
        try {
          return {
            group: await approveTaskGroup(deps, principal, proposed.id, 'command'),
            started: true,
          }
        } catch (error) {
          if (!(error instanceof TaskError)) throw error
          return { group: proposed, started: false, reason: error.message }
        }
      } catch (error) {
        if (error instanceof TaskError)
          throw error.missing
            ? new ForbiddenToolError(error.message, error.missing.action, error.missing.target)
            : new ToolError(error.message)
        throw error
      }
    },
    status,
    async requestReview(id, repo) {
      const found = await findGroup(deps, principal, id)
      if (!found) throw new ToolError(`No task ${id} you may see.`)
      const tasks = await deps.store.tasks.list({ groupIds: [found.group.id] })
      const task =
        found.task ??
        (repo
          ? tasks.find((each) => each.repo === repo)
          : tasks.length === 1
            ? tasks[0]
            : undefined)
      if (!task) throw new ToolError('Pass the repository (forge:path) of the task to review.')
      if (!task.mergeRequest || task.status !== 'mr-open')
        throw new ToolError(`The task in ${task.repo} has no open merge request.`)
      const target = targetOf(deps, task.repo)
      if (!options.mayRun || !(await canRunTask(deps, principal, target)))
        throw new ForbiddenToolError(
          `You may not request reviews in ${task.repo} (needs tasks:run).`,
          'tasks:run',
          task.repo,
        )
      const job = await deps.store.jobs.enqueue({
        analyzer: 'review',
        repo: target,
        options: { mergeRequest: task.mergeRequest.id, reviewOwn: true, force: true },
        trigger: 'command',
        createdAt: deps.now().toISOString(),
        actor: principal.id,
        reason: `review of task ${task.id}`,
      })
      return `Queued review job ${job.id} for !${task.mergeRequest.id} in ${task.repo}.`
    },
  }
}
