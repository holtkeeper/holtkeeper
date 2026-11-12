import type {
  AgentTaskCi,
  AgentTaskGroupView,
  AgentTaskKind,
  AgentTaskSource,
  AgentTaskStatus,
  AgentTaskView,
  PersonView,
  PutSettingInput,
  SettingView,
  WriteTasksStatus,
} from '@holtkeeper/api'

import type { StatusTone } from '../ui/colors.ts'
import { unreadBadge } from './chat.ts'
import type { FlowEdgeSpec, FlowNodeSpec } from './flow.ts'
import { plural } from './format.ts'

/** How a task or task group status reads in the panel. */
export const taskStatusLabel: Record<AgentTaskStatus, string> = {
  proposed: 'Needs approval',
  approved: 'Approved',
  queued: 'Queued',
  running: 'Running',
  'mr-open': 'MR open',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

/** Status color of a task status: warning while it waits for people, info while workers have it. */
export const taskStatusTone: Record<AgentTaskStatus, StatusTone> = {
  proposed: 'warning',
  approved: 'default',
  queued: 'default',
  running: 'info',
  'mr-open': 'success',
  done: 'success',
  failed: 'danger',
  cancelled: 'default',
}

/** How the CI of a task's merge request reads, e.g. under a "CI" heading. */
export const taskCiLabel: Record<AgentTaskCi, string> = {
  none: 'No pipeline',
  pending: 'Pending',
  running: 'Running',
  success: 'Passed',
  failed: 'Failed',
  canceled: 'Canceled',
}

/** Status color of a merge request's CI. */
export const taskCiTone: Record<AgentTaskCi, StatusTone> = {
  none: 'default',
  pending: 'warning',
  running: 'info',
  success: 'success',
  failed: 'danger',
  canceled: 'default',
}

const ciRank: readonly AgentTaskCi[] = [
  'failed',
  'running',
  'pending',
  'canceled',
  'success',
  'none',
]

/**
 * The CI column of a task group: the most pressing CI among its tasks with a merge request
 * (failed, running, pending, canceled, passed, no pipeline, in that order), labelled with how many
 * of those merge requests share it when they differ, e.g. "Failed · 1 of 3". `undefined` while no
 * task has a merge request.
 */
export function groupCiSummary(
  tasks: readonly Pick<AgentTaskView, 'ci' | 'mergeRequest'>[],
): { ci: AgentTaskCi; label: string } | undefined {
  const cis = tasks.filter((task) => task.mergeRequest).map((task) => task.ci)
  const ci = ciRank.find((each) => cis.includes(each))
  if (!ci) return undefined
  const same = cis.filter((each) => each === ci).length
  return {
    ci,
    label: same === cis.length ? taskCiLabel[ci] : `${taskCiLabel[ci]} · ${same} of ${cis.length}`,
  }
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

/**
 * Busy workers against the live ones as the write pool shows them (`1 / 3`); just the busy count
 * when the server reports no registry. The total counts workers of every pool.
 */
export const writeWorkersText = (
  pool: Pick<WriteTasksStatus['pool'], 'busyWorkers' | 'totalWorkers'>,
): string =>
  pool.totalWorkers === undefined
    ? `${pool.busyWorkers} busy`
    : `${pool.busyWorkers} / ${pool.totalWorkers}`

/** Label and tone of a write pool state. */
export const writePoolLabel: Record<WritePoolState, { label: string; tone: StatusTone }> = {
  off: { label: 'Turned off', tone: 'default' },
  idle: { label: 'Idle', tone: 'success' },
  working: { label: 'Working', tone: 'accent' },
  stalled: { label: 'No write worker', tone: 'warning' },
}

/** The global `tasks.write` entry: the one the server reads the switch and caps from. */
export const writeTasksEntry = (entries: readonly SettingView[]): SettingView | undefined =>
  entries.find(
    (entry) => entry.key === 'tasks.write' && 'all' in entry.scope && entry.scope.all === true,
  )

/**
 * The `tasks.write` entry that turns write tasks on or off for everything: the global entry with
 * only `enabled` changed (keeping its caps), or a new global entry. Entries of narrower scopes
 * are ignored; the server reads the switch globally.
 */
export function writeTasksSwitch(
  entries: readonly SettingView[],
  enabled: boolean,
): PutSettingInput {
  const global = writeTasksEntry(entries)
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

/** Sections of the Tasks list, in the order they are shown. */
export type TaskSection = 'approval' | 'running' | 'opened' | 'failed' | 'ended'

/** Heading, status tone and a quiet hint of each section. */
export const taskSectionInfo: Record<
  TaskSection,
  { label: string; tone: StatusTone; hint: string }
> = {
  approval: {
    label: 'Needs approval',
    tone: 'warning',
    hint: 'nothing runs until someone approves',
  },
  running: { label: 'Running', tone: 'info', hint: 'on write workers or waiting for one' },
  opened: { label: 'Opened MR', tone: 'success', hint: 'waiting for review on the forge' },
  failed: { label: 'Failed', tone: 'danger', hint: 'retry one repository or the whole task' },
  ended: { label: 'Ended', tone: 'default', hint: 'merged, nothing to change, or cancelled' },
}

const sectionOrder: readonly TaskSection[] = ['approval', 'running', 'opened', 'failed', 'ended']

/**
 * The section a task group belongs to: `approval` while a task waits for approval, `running` while
 * one is approved, queued or running, `failed` when a task failed and none of them still works
 * (even with other merge requests open), `opened` while merge requests are open, else `ended`.
 */
export function taskSectionOf(
  group: Pick<AgentTaskGroupView, 'status'> & { tasks: readonly Pick<AgentTaskView, 'status'>[] },
): TaskSection {
  switch (group.status) {
    case 'proposed':
      return 'approval'
    case 'approved':
    case 'queued':
    case 'running':
      return 'running'
    case 'mr-open':
      return group.tasks.some((task) => task.status === 'failed') ? 'failed' : 'opened'
    case 'failed':
      return 'failed'
    default:
      return 'ended'
  }
}

/** Which sections the Tasks list shows: still open ones, ended ones, or all. */
export type TaskView = 'open' | 'ended' | 'all'

const taskViews: readonly TaskView[] = ['open', 'ended', 'all']

const inView = (section: TaskSection, view: TaskView) =>
  view === 'all' || (view === 'ended') === (section === 'ended')

/** `groups` split into the sections `view` shows, in section order, keeping their order; empty sections are left out. */
export function taskSections<G extends Parameters<typeof taskSectionOf>[0]>(
  groups: readonly G[],
  view: TaskView,
): { id: TaskSection; groups: G[] }[] {
  return sectionOrder.flatMap((id) => {
    if (!inView(id, view)) return []
    const members = groups.filter((group) => taskSectionOf(group) === id)
    return members.length ? [{ id, groups: members }] : []
  })
}

/** How many groups each view shows. */
export function taskViewCounts(
  groups: readonly Parameters<typeof taskSectionOf>[0][],
): Record<TaskView, number> {
  const ended = groups.filter((group) => taskSectionOf(group) === 'ended').length
  return { open: groups.length - ended, ended, all: groups.length }
}

/** How many of `groups` wait for approval. */
export const needsApprovalCount = (
  groups: readonly Parameters<typeof taskSectionOf>[0][],
): number => groups.filter((group) => taskSectionOf(group) === 'approval').length

/** Text of the Tasks tab badge from the needs-approval count: empty for none, `99+` past 99. */
export const taskApprovalBadge = (count: number | undefined): string => unreadBadge(count ?? 0)

/**
 * The quiet text after a section heading: for Running how many repositories workers have and how
 * many wait ("2 repositories on workers · 4 queued"), for Opened MR how many drafts wait for
 * review, else the section's hint.
 */
export function taskSectionCaption(
  section: TaskSection,
  groups: readonly { tasks: readonly Pick<AgentTaskView, 'status' | 'mergeRequest'>[] }[],
): string {
  const tasks = groups.flatMap((group) => group.tasks)
  if (section === 'running') {
    const running = tasks.filter((task) => task.status === 'running').length
    const queued = tasks.filter(
      (task) => task.status === 'queued' || task.status === 'approved',
    ).length
    return `${plural(running, 'repository', 'repositories')} on workers · ${queued} queued`
  }
  if (section === 'opened') {
    const drafts = tasks.filter((task) => task.mergeRequest?.draft).length
    return `${taskSectionInfo.opened.hint} · ${plural(drafts, 'draft merge request')}`
  }
  return taskSectionInfo[section].hint
}

/** "41 done, 6 cancelled" for the ended groups among `groups`. */
export function endedSummary(groups: readonly Parameters<typeof taskSectionOf>[0][]): string {
  const ended = groups.filter((group) => taskSectionOf(group) === 'ended')
  const cancelled = ended.filter((group) => group.status === 'cancelled').length
  return `${ended.length - cancelled} done, ${cancelled} cancelled`
}

/**
 * The caption next to a group's progress bar: "0 of 5" before anything started, "2 of 2" once
 * every repository has a merge request or ended done, else the counts that matter, e.g.
 * "1 MR · 1 running · 1 queued".
 */
export function taskProgressCaption(tasks: readonly Pick<AgentTaskView, 'status'>[]): string {
  const count = (...statuses: AgentTaskStatus[]) =>
    tasks.filter((task) => statuses.includes(task.status)).length
  const opened = count('mr-open', 'done')
  if (count('proposed') === tasks.length || opened === tasks.length)
    return `${opened} of ${tasks.length}`
  const parts: [number, string][] = [
    [opened, 'MR'],
    [count('running'), 'running'],
    [count('approved', 'queued'), 'queued'],
    [count('proposed'), 'waiting'],
    [count('failed'), 'failed'],
    [count('cancelled'), 'cancelled'],
  ]
  return parts
    .filter(([value]) => value > 0)
    .map(([value, word]) => `${value} ${word}`)
    .join(' · ')
}

/** The diffstat of a change, summed over tasks or files. */
export interface Diffstat {
  files: number
  additions: number
  deletions: number
}

/**
 * The size of a group's change: the diffstats its tasks know summed, with how many repositories
 * they cover. `undefined` while no task knows one.
 */
export function groupDiffstat(
  tasks: readonly Pick<AgentTaskView, 'diffstat'>[],
): (Diffstat & { repos: number }) | undefined {
  const known = tasks.flatMap((task) => (task.diffstat ? [task.diffstat] : []))
  if (!known.length) return undefined
  return {
    files: known.reduce((sum, stat) => sum + stat.files, 0),
    additions: known.reduce((sum, stat) => sum + stat.additions, 0),
    deletions: known.reduce((sum, stat) => sum + stat.deletions, 0),
    repos: known.length,
  }
}

/** "9 files · +64 −41". */
export const formatDiffstat = (stat: Diffstat): string =>
  `${plural(stat.files, 'file')} · +${stat.additions} −${stat.deletions}`

/**
 * Shares of a diffstat bar scaled to `max` changed lines (the largest row): added, removed and the
 * empty rest, each between 0 and 1 and summing to 1.
 */
export function diffstatShares(
  stat: Pick<Diffstat, 'additions' | 'deletions'>,
  max: number,
): { add: number; del: number; rest: number } {
  const total = stat.additions + stat.deletions
  const scale = Math.max(max, total)
  if (scale <= 0) return { add: 0, del: 0, rest: 1 }
  const add = stat.additions / scale
  const del = stat.deletions / scale
  return { add, del, rest: Math.max(0, 1 - add - del) }
}

/**
 * Files a unified diff touches with the lines it adds and removes, in diff order. File headers
 * (`---`, `+++`) are not counted; a file is named by its `+++ b/` path, or its `--- a/` path when
 * deleted.
 */
export function patchFiles(
  patch: string,
): { path: string; additions: number; deletions: number }[] {
  const files: { path: string; additions: number; deletions: number }[] = []
  let current: (typeof files)[number] | undefined
  let from = ''
  let inHunk = false
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = undefined
      inHunk = false
      continue
    }
    if (!inHunk && line.startsWith('--- ')) {
      from = line.slice(4).replace(/^a\//, '')
      continue
    }
    if (!inHunk && line.startsWith('+++ ')) {
      const to = line.slice(4).replace(/^b\//, '')
      current = { path: to === '/dev/null' ? from : to, additions: 0, deletions: 0 }
      files.push(current)
      continue
    }
    if (line.startsWith('@@')) {
      inHunk = true
      continue
    }
    if (!current || !inHunk) continue
    if (line.startsWith('+')) current.additions += 1
    else if (line.startsWith('-')) current.deletions += 1
    else if (!line.startsWith(' ') && !line.startsWith('\\')) inHunk = false
  }
  return files
}

/**
 * What a group may spend at most: the tasks' own caps summed once every task has one, else the
 * split of the `tasks.write` caps over its repositories, else `undefined`.
 */
export function groupSpendCap(
  group: { tasks: readonly Pick<AgentTaskView, 'budgetUsd'>[] },
  caps: Caps | undefined,
): number | undefined {
  const budgets = group.tasks.flatMap((task) =>
    task.budgetUsd === undefined ? [] : [task.budgetUsd],
  )
  if (budgets.length && budgets.length === group.tasks.length)
    return Math.round(budgets.reduce((sum, value) => sum + value, 0) * 100) / 100
  return caps ? taskGroupCap(caps, group.tasks.length).total : undefined
}

/** How each kind of source reads in the Source filter. */
const taskSourceTypeLabel: Record<AgentTaskSource['type'], string> = {
  chat: 'Chat',
  'dependency-upgrade': 'Dependency upgrade',
  propagate: 'Rollout',
  mcp: 'MCP',
  api: 'API',
}

/** The Tasks list filters; an empty list means any. */
export interface TaskListFilter {
  /** Matches the title, a repository, a merge request (`!12`) or the id's start. */
  query: string
  kinds: readonly string[]
  sources: readonly string[]
  repos: readonly string[]
  proposers: readonly string[]
}

const anyOf = (chosen: readonly string[], values: readonly string[]) =>
  !chosen.length || values.some((value) => chosen.includes(value))

/** Whether a group passes every filter. */
export function matchesTaskList(group: AgentTaskGroupView, filter: TaskListFilter): boolean {
  if (!anyOf(filter.kinds, [group.kind])) return false
  if (!anyOf(filter.sources, [group.source.type])) return false
  if (!anyOf(filter.repos, group.repos)) return false
  if (!anyOf(filter.proposers, [group.proposedBy])) return false
  const query = filter.query.trim().toLowerCase()
  if (!query) return true
  return [
    group.title,
    group.id.slice(0, 8),
    ...group.repos,
    ...group.tasks.flatMap((task) => (task.mergeRequest ? [`!${task.mergeRequest.id}`] : [])),
  ].some((value) => value.toLowerCase().includes(query))
}

const filterOptions = (entries: Iterable<[string, string]>) =>
  [...new Map(entries)]
    .map(([id, label]) => ({ id, label }))
    .toSorted((a, b) => a.label.localeCompare(b.label))

/** The choices of each Tasks filter: what `groups` actually hold, sorted by label. */
export function taskFilterOptions(
  groups: readonly AgentTaskGroupView[],
  people: Record<string, Pick<PersonView, 'name'>>,
): Record<'kinds' | 'sources' | 'repos' | 'proposers', { id: string; label: string }[]> {
  return {
    kinds: filterOptions(groups.map((group) => [group.kind, taskKindLabel[group.kind]])),
    sources: filterOptions(
      groups.map((group) => [group.source.type, taskSourceTypeLabel[group.source.type]]),
    ),
    repos: filterOptions(
      groups.flatMap((group) => group.repos.map((repo) => [repo, repo] as [string, string])),
    ),
    proposers: filterOptions(
      groups.map((group) => [group.proposedBy, people[group.proposedBy]?.name ?? group.proposedBy]),
    ),
  }
}

/**
 * The teams (repository groups) a task group touches: every group of its repositories, from a
 * `forge:path` → groups map; repositories the map does not know add nothing.
 */
export function taskGroupTeams(
  group: Pick<AgentTaskGroupView, 'repos'>,
  repoGroups: ReadonlyMap<string, readonly string[]>,
): string[] {
  return [...new Set(group.repos.flatMap((repo) => repoGroups.get(repo) ?? []))]
}

/** A tab of a task group's side sheet. */
export type TaskSheetTab = 'plan' | 'repos' | 'diff' | 'runs' | 'request' | 'flow'

const sheetTabs: readonly TaskSheetTab[] = ['plan', 'repos', 'diff', 'runs', 'request', 'flow']

/** A sheet tab id, or `plan` for anything else. */
export const parseTaskSheetTab = (value: unknown): TaskSheetTab =>
  sheetTabs.find((tab) => tab === value) ?? 'plan'

/** The `/ops/tasks` search parameters: the open group, its tab and open task, and the view. */
export interface TasksSearch {
  group?: string
  task?: string
  tab?: Exclude<TaskSheetTab, 'plan'>
  view?: Exclude<TaskView, 'open'>
}

const nonEmpty = (value: unknown) => (typeof value === 'string' && value ? value : undefined)

/** Parses `/ops/tasks` search parameters, dropping anything unknown; a task or tab needs a group. */
export function parseTasksSearch(search: Record<string, unknown>): TasksSearch {
  const group = nonEmpty(search.group)
  const task = nonEmpty(search.task)
  const tab = sheetTabs.find((each) => each !== 'plan' && each === search.tab)
  const view = taskViews.find((each) => each !== 'open' && each === search.view)
  return {
    ...(group && { group }),
    ...(group && task && { task }),
    ...(group && tab && tab !== 'plan' && { tab }),
    ...(view && view !== 'open' && { view }),
  }
}
