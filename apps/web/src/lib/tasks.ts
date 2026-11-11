import type {
  AgentTaskCi,
  AgentTaskGroupView,
  AgentTaskKind,
  AgentTaskSource,
  AgentTaskStatus,
  AgentTaskView,
  PutSettingInput,
  SettingView,
  WriteTasksStatus,
} from '@holtkeeper/api'

import type { StatusTone } from '../ui/colors.ts'
import type { FlowEdgeSpec, FlowNodeSpec } from './flow.ts'

/** How a task or task group status reads in the panel. */
export const taskStatusLabel: Record<AgentTaskStatus, string> = {
  proposed: 'Proposed',
  approved: 'Approved',
  queued: 'Queued',
  running: 'Running',
  'mr-open': 'MR open',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

/** Status color of a task status: info while waiting or working, success once done or open. */
export const taskStatusTone: Record<AgentTaskStatus, StatusTone> = {
  proposed: 'info',
  approved: 'info',
  queued: 'info',
  running: 'accent',
  'mr-open': 'success',
  done: 'success',
  failed: 'danger',
  cancelled: 'default',
}

/** How the CI of a task's merge request reads. */
export const taskCiLabel: Record<AgentTaskCi, string> = {
  none: 'No pipeline',
  pending: 'CI pending',
  running: 'CI running',
  success: 'CI passed',
  failed: 'CI failed',
  canceled: 'CI canceled',
}

/** Status color of a merge request's CI. */
export const taskCiTone: Record<AgentTaskCi, StatusTone> = {
  none: 'default',
  pending: 'info',
  running: 'accent',
  success: 'success',
  failed: 'danger',
  canceled: 'default',
}

/** How a task kind reads. */
export const taskKindLabel: Record<AgentTaskKind, string> = {
  fix: 'Fix',
  port: 'Port',
  upgrade: 'Upgrade',
  'propagate-fix': 'Propagate fix',
  chat: 'Chat request',
  tests: 'Tests',
}

/** Where a task group came from, in a few words. */
export function taskSourceLabel(source: AgentTaskSource): string {
  switch (source.type) {
    case 'chat':
      return 'Chat'
    case 'dependency-upgrade':
      return `${source.package} ${source.from ? `${source.from} → ` : '→ '}${source.to}`
    case 'propagate':
      return source.group ? `Rollout · ${source.group}` : 'Rollout'
    case 'mcp':
      return source.client ? `MCP · ${source.client}` : 'MCP'
    default:
      return 'API'
  }
}

/** Statuses a task still works or waits in. */
const activeStatuses: ReadonlySet<AgentTaskStatus> = new Set([
  'proposed',
  'approved',
  'queued',
  'running',
])

/** Whether a task or group in `status` still waits or works, so it can be cancelled. */
export const taskCancellable = (status: AgentTaskStatus): boolean => activeStatuses.has(status)

/** Filters of the Tasks list: what still needs people or workers, open merge requests, ended. */
const taskFilters = ['all', 'active', 'mr-open', 'ended'] as const

export type TaskFilter = (typeof taskFilters)[number]

/** Whether a group belongs under `filter`. */
export function matchesTaskFilter(
  group: Pick<AgentTaskGroupView, 'status'>,
  filter: TaskFilter,
): boolean {
  if (filter === 'all') return true
  if (filter === 'active') return activeStatuses.has(group.status)
  if (filter === 'mr-open') return group.status === 'mr-open'
  return !activeStatuses.has(group.status) && group.status !== 'mr-open'
}

const segmentOrder: readonly AgentTaskStatus[] = [
  'done',
  'mr-open',
  'running',
  'queued',
  'approved',
  'proposed',
  'failed',
  'cancelled',
]

/** The tasks of a group counted by status, for a segment bar; empty statuses are left out. */
export function taskSegments(
  tasks: readonly Pick<AgentTaskView, 'status'>[],
): { value: number; tone: StatusTone; label: string }[] {
  return segmentOrder.flatMap((status) => {
    const value = tasks.filter((task) => task.status === status).length
    return value ? [{ value, tone: taskStatusTone[status], label: taskStatusLabel[status] }] : []
  })
}

/** The `tasks.write` caps the spend estimate needs. */
type Caps = Pick<WriteTasksStatus, 'perRepoUsd' | 'perGroupUsd'>

/**
 * What a task over `repos` repositories may spend at most, as the server splits it: each
 * repository gets `perRepoUsd`, lowered (to the cent) so all of them stay within `perGroupUsd`.
 */
export function taskGroupCap(caps: Caps, repos: number): { perRepo: number; total: number } {
  if (repos <= 0) return { perRepo: 0, total: 0 }
  const perRepo = Math.floor(Math.min(caps.perRepoUsd, caps.perGroupUsd / repos) * 100) / 100
  return { perRepo, total: Math.round(perRepo * repos * 100) / 100 }
}

/** How the write pool is doing: switched off, idle, working, or tasks waiting with no worker. */
export type WritePoolState = 'off' | 'idle' | 'working' | 'stalled'

/**
 * The state of the write pool: `off` while `tasks.write` is off, `working` while a write worker
 * runs a task, `stalled` when a task has waited longer than `staleAfterMs` and nothing runs (no
 * write worker is likely up), else `idle`.
 */
export function writePoolState(
  status: Pick<WriteTasksStatus, 'enabled' | 'pool'>,
  now: Date,
  staleAfterMs = 5 * 60_000,
): WritePoolState {
  if (!status.enabled) return 'off'
  if (status.pool.running > 0) return 'working'
  const oldest = status.pool.oldestQueuedAt
  if (oldest && now.getTime() - Date.parse(oldest) > staleAfterMs) return 'stalled'
  return 'idle'
}

/** Label and tone of a write pool state. */
export const writePoolLabel: Record<WritePoolState, { label: string; tone: StatusTone }> = {
  off: { label: 'Turned off', tone: 'default' },
  idle: { label: 'Idle', tone: 'success' },
  working: { label: 'Working', tone: 'accent' },
  stalled: { label: 'No write worker', tone: 'warning' },
}

/**
 * The `tasks.write` entry that turns write tasks on or off for everything: the global entry with
 * only `enabled` changed (keeping its caps), or a new global entry. Entries of narrower scopes
 * are ignored; the server reads the switch globally.
 */
export function writeTasksSwitch(
  entries: readonly SettingView[],
  enabled: boolean,
): PutSettingInput {
  const global = entries.find(
    (entry) => entry.key === 'tasks.write' && 'all' in entry.scope && entry.scope.all === true,
  )
  const value =
    global && typeof global.value === 'object' && global.value !== null ? global.value : {}
  return {
    ...(global && { id: global.id }),
    key: 'tasks.write',
    scope: { all: true },
    value: { ...value, enabled },
  }
}

/** The nodes of a task group diagram. */
export type TaskFlowNode =
  | FlowNodeSpec<
      'source',
      { title: string; kind: AgentTaskKind; source: AgentTaskSource; status: AgentTaskStatus }
    >
  | FlowNodeSpec<'repo', { task: AgentTaskView }>
  | FlowNodeSpec<'request', { repo: string; reason: string }>
  | FlowNodeSpec<'mr', { task: AgentTaskView }>
  | FlowNodeSpec<'ci', { ci: AgentTaskCi }>

const ciEdgeTone = (ci: AgentTaskCi): StatusTone | undefined =>
  ci === 'success' ? 'success' : ci === 'failed' ? 'danger' : undefined

/**
 * A task group as a left-to-right diagram: the source, then one node per target repository
 * colored by its task's status, its merge request once opened and the CI of that merge request.
 * Repositories a task asked for and people have not decided on hang off that task's repository,
 * dashed. Edges to failed or cancelled tasks are colored by their status.
 */
export function taskGroupFlow(group: AgentTaskGroupView): {
  nodes: TaskFlowNode[]
  edges: FlowEdgeSpec[]
} {
  const nodes: TaskFlowNode[] = [
    {
      id: 'source',
      kind: 'source',
      data: { title: group.title, kind: group.kind, source: group.source, status: group.status },
      width: 220,
    },
  ]
  const edges: FlowEdgeSpec[] = []
  for (const task of group.tasks) {
    const repoId = `repo:${task.id}`
    nodes.push({ id: repoId, kind: 'repo', data: { task }, width: 220 })
    const tone = task.status === 'failed' ? 'danger' : undefined
    edges.push({
      from: 'source',
      to: repoId,
      ...(tone && { tone }),
      ...(task.status === 'proposed' || task.status === 'cancelled' ? { dashed: true } : {}),
    })
    const mr = task.mergeRequest
    if (!mr) continue
    const mrId = `mr:${task.id}`
    nodes.push({ id: mrId, kind: 'mr', data: { task }, width: 150 })
    edges.push({ from: repoId, to: mrId, tone: taskStatusTone[task.status] })
    const ci = mr.ci ?? 'none'
    if (ci === 'none') continue
    const ciId = `ci:${task.id}`
    nodes.push({ id: ciId, kind: 'ci', data: { ci }, width: 130, height: 44 })
    const ciTone = ciEdgeTone(ci)
    edges.push({ from: mrId, to: ciId, ...(ciTone && { tone: ciTone }) })
  }
  for (const request of group.requests ?? []) {
    if (request.status !== 'pending') continue
    const asking = group.tasks.find((task) => task.id === request.taskId)
    const id = `request:${request.repo}`
    nodes.push({ id, kind: 'request', data: { repo: request.repo, reason: request.reason } })
    edges.push({
      from: asking ? `repo:${asking.id}` : 'source',
      to: id,
      dashed: true,
      label: 'asks',
    })
  }
  return { nodes, edges }
}

/** The `/tasks` search parameters: the open group, its open task and the list filter. */
export interface TasksSearch {
  group?: string
  task?: string
  filter?: Exclude<TaskFilter, 'all'>
}

const nonEmpty = (value: unknown) => (typeof value === 'string' && value ? value : undefined)

/** Parses `/tasks` search parameters, dropping anything unknown. */
export function parseTasksSearch(search: Record<string, unknown>): TasksSearch {
  const group = nonEmpty(search.group)
  const task = nonEmpty(search.task)
  const filter = taskFilters.find((each) => each !== 'all' && each === search.filter)
  return {
    ...(group && { group }),
    ...(group && task && { task }),
    ...(filter && filter !== 'all' && { filter }),
  }
}
