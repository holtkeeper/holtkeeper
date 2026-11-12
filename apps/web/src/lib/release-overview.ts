import type { DeployStatus, PipelineState, ReleaseBoardRow, ReleaseCard } from '@holtkeeper/api'

import type { StatusTone } from '../ui/colors.ts'
import type { DotTone } from '../ui/Legend.tsx'
import type { Tick } from '../ui/TickStrip.tsx'
import type { SortValue } from './table-sort.ts'

/**
 * Where a repository stands on the Releases overview, one word per row: what needs a person
 * first, then what runs, then what rests.
 */
export type OverviewState =
  | 'unread'
  | 'deploy-failed'
  | 'acceptance'
  | 'ready-to-tag'
  | 'proposed'
  | 'candidate'
  | 'deploy-ready'
  | 'deploying'
  | 'released'
  | 'idle'
  | 'external'

/** Every `OverviewState`, most urgent first. */
export const overviewStateOrder: readonly OverviewState[] = [
  'unread',
  'deploy-failed',
  'acceptance',
  'ready-to-tag',
  'proposed',
  'candidate',
  'deploy-ready',
  'deploying',
  'released',
  'idle',
  'external',
]

/** The words and status tone of each `OverviewState`. */
export const overviewStates: Record<OverviewState, { label: string; tone: DotTone }> = {
  unread: { label: 'Could not read the forge', tone: 'danger' },
  'deploy-failed': { label: 'Deploy failed', tone: 'danger' },
  acceptance: { label: 'Waiting for acceptance', tone: 'warning' },
  'ready-to-tag': { label: 'Ready to tag', tone: 'warning' },
  proposed: { label: 'Release MR open', tone: 'info' },
  candidate: { label: 'Ready to propose', tone: 'info' },
  'deploy-ready': { label: 'Ready to deploy', tone: 'warning' },
  deploying: { label: 'Deploying', tone: 'info' },
  released: { label: 'Released', tone: 'success' },
  idle: { label: 'Nothing to release', tone: 'none' },
  external: { label: 'Released elsewhere', tone: 'none' },
}

const envWith = (row: ReleaseBoardRow, statuses: readonly DeployStatus[]) =>
  row.environments.find((env) => statuses.includes(env.status))

/**
 * The state of a row: a forge error, then a failed deploy, then the pending step (a version
 * waits for acceptance when the flow needs one and nobody accepted yet), then a deploy that is
 * ready or running, else the stage.
 */
export function overviewState(row: ReleaseBoardRow): OverviewState {
  if (row.error) return 'unread'
  if (envWith(row, ['failed'])) return 'deploy-failed'
  if (row.stage === 'awaiting-version')
    return row.acceptanceRequired && !row.acceptance ? 'acceptance' : 'ready-to-tag'
  if (row.stage === 'proposed') return 'proposed'
  if (row.stage === 'candidate') return 'candidate'
  if (envWith(row, ['ready'])) return 'deploy-ready'
  if (envWith(row, ['running', 'pending'])) return 'deploying'
  return row.stage
}

/** The state of a row in words, naming the environment of a deploy, e.g. "Deploying to prod". */
export function overviewStateText(row: ReleaseBoardRow): string {
  const state = overviewState(row)
  if (state === 'deploy-failed') return `Deploy to ${envWith(row, ['failed'])?.name} failed`
  if (state === 'deploying') return `Deploying to ${envWith(row, ['running', 'pending'])?.name}`
  return overviewStates[state].label
}

/** The state tag of a row: its words and a `Tag` tone. */
export function overviewTag(row: ReleaseBoardRow): { label: string; tone: StatusTone } {
  const tone = overviewStates[overviewState(row)].tone
  return { label: overviewStateText(row), tone: tone === 'none' ? 'default' : tone }
}

const rank = (row: ReleaseBoardRow) => overviewStateOrder.indexOf(overviewState(row))

/** Default order of the overview: rows that need a person first, then by state, then by path. */
export const actionFirst = <T extends ReleaseCard>(rows: readonly T[]): T[] =>
  rows.toSorted(
    (a, b) =>
      Number(b.needsAction) - Number(a.needsAction) ||
      rank(a) - rank(b) ||
      a.repo.path.localeCompare(b.repo.path),
  )

/** Columns of the overview table that sort. */
const overviewSortKeys = ['repo', 'stage', 'latest', 'next', 'unreleased', 'ci'] as const

export type OverviewSortKey = (typeof overviewSortKeys)[number]

const pipelineRank: Record<PipelineState['status'], number> = {
  failed: 0,
  canceled: 1,
  running: 2,
  pending: 3,
  manual: 4,
  skipped: 5,
  success: 6,
}

const sortValues: Record<OverviewSortKey, (row: ReleaseCard) => SortValue> = {
  repo: (row) => row.repo.path,
  stage: (row) => rank(row),
  latest: (row) => (row.latest?.date ? new Date(row.latest.date) : row.latest?.version),
  next: (row) => row.next,
  unreleased: (row) => row.unreleased,
  ci: (row) => {
    const status = row.pipelines.target?.status
    return status ? pipelineRank[status] : undefined
  },
}

/** The value a row sorts by in the column `key`, for `sortRows`. */
export const overviewSortValue = (row: ReleaseCard, key: OverviewSortKey): SortValue =>
  sortValues[key](row)

/** Rows whose path, latest or next version contains `query` (any case); all rows when it is empty. */
export function filterOverview<T extends ReleaseBoardRow>(rows: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...rows]
  return rows.filter((row) =>
    [row.repo.path, row.latest?.tag, row.latest?.version, row.next].some((text) =>
      text?.toLowerCase().includes(needle),
    ),
  )
}

/** Figures of the overview strip over the rows in scope. */
export interface OverviewCounts {
  repos: number
  needsAction: number
  acceptance: number
  proposed: number
  deploying: number
  deployFailed: number
  unread: number
  unreleased: number
  /** Some row counted at most what the forge returned, so `unreleased` is a lower bound. */
  unreleasedCapped: boolean
}

/** Counts by state, rows needing action and unreleased commits on the targets. */
export function overviewCounts(rows: readonly ReleaseCard[]): OverviewCounts {
  const states = rows.map(overviewState)
  const count = (state: OverviewState) => states.filter((candidate) => candidate === state).length
  return {
    repos: rows.length,
    needsAction: rows.filter((row) => row.needsAction).length,
    acceptance: count('acceptance'),
    proposed: count('proposed'),
    deploying: count('deploying'),
    deployFailed: count('deploy-failed'),
    unread: count('unread'),
    unreleased: rows.reduce((sum, row) => sum + row.unreleased, 0),
    unreleasedCapped: rows.some((row) => row.unreleasedCapped),
  }
}

/** Filters of the release queue: every row needing a person, or one state among them. */
export const queueFilters = [
  'action',
  'acceptance',
  'ready-to-tag',
  'proposed',
  'deploy-failed',
] as const

export type QueueFilter = (typeof queueFilters)[number]

/** Rows of the queue for `filter`: those needing a person, in `actionFirst` order. */
export function queueRows<T extends ReleaseCard>(
  rows: readonly T[],
  filter: QueueFilter = 'action',
): T[] {
  return actionFirst(
    rows.filter((row) => row.needsAction && (filter === 'action' || overviewState(row) === filter)),
  )
}

/** How many rows each queue filter keeps. */
export function queueCounts(rows: readonly ReleaseCard[]): Record<QueueFilter, number> {
  const count = (filter: QueueFilter) => queueRows(rows, filter).length
  return {
    action: count('action'),
    acceptance: count('acceptance'),
    'ready-to-tag': count('ready-to-tag'),
    proposed: count('proposed'),
    'deploy-failed': count('deploy-failed'),
  }
}

/** Where a next step leads: the repository's timeline, or the forge credentials. */
type NextStepTarget = 'timeline' | 'integrations'

/** The one step a person would take next on a row. */
export interface NextStep {
  label: string
  to: NextStepTarget
  /** Something waits for a person; otherwise the step is a quiet way in. */
  action: boolean
}

const timeline = (label: string, action = true): NextStep => ({ label, to: 'timeline', action })

/**
 * The next step of a row: fix the forge when it could not be read, retry a failed deploy, accept
 * (only when the caller may) or create the version, review or open the release merge request,
 * deploy where it is ready, follow a running deploy, else open the timeline.
 */
export function nextStep(row: ReleaseCard): NextStep {
  const next = row.next ? ` ${row.next}` : ''
  switch (overviewState(row)) {
    case 'unread':
      return { label: 'Check the forge', to: 'integrations', action: true }
    case 'deploy-failed':
      return timeline(`Retry ${envWith(row, ['failed'])?.name}`)
    case 'acceptance':
      return row.can.accept ? timeline(`Accept${next}`) : timeline('Review changes', false)
    case 'ready-to-tag':
      return timeline(`Create${next || ' version'}`)
    case 'proposed':
      return timeline(row.request ? `Review !${row.request.id}` : 'Review')
    case 'candidate':
      return timeline('Open release MR')
    case 'deploy-ready':
      return timeline(`Deploy to ${envWith(row, ['ready'])?.name}`)
    case 'deploying':
      return timeline('Follow the deploy', false)
    default:
      return timeline('Open timeline', false)
  }
}

/** Above this many environments the table shows them as one `TickStrip` column. */
const maxEnvironmentColumns = 3

/** Environment columns of the overview table. */
export interface EnvironmentColumns {
  /** Every environment name across the rows, in the order they first appear. */
  names: string[]
  /** More than three names: one tick strip column instead of a column per environment. */
  ticks: boolean
}

/** The union of environment names across `rows` and whether they collapse to a tick strip. */
export function environmentColumns(rows: readonly ReleaseBoardRow[]): EnvironmentColumns {
  const names = [...new Set(rows.flatMap((row) => row.environments.map((env) => env.name)))]
  return { names, ticks: names.length > maxEnvironmentColumns }
}

/** The words and tone of a deploy status in an environment cell. */
export const environmentStatus: Record<DeployStatus, { label: string; tone: DotTone }> = {
  'no-pipeline': { label: 'No pipeline', tone: 'none' },
  missing: { label: 'No job', tone: 'none' },
  waiting: { label: 'Waiting', tone: 'none' },
  ready: { label: 'Ready', tone: 'warning' },
  pending: { label: 'Pending', tone: 'info' },
  running: { label: 'Running', tone: 'info' },
  success: { label: 'Deployed', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  canceled: { label: 'Canceled', tone: 'warning' },
  skipped: { label: 'Skipped', tone: 'none' },
}

/** Rows that deploy to any of `names`, in their order; all rows when `names` is empty. */
export function withEnvironments<T extends ReleaseBoardRow>(
  rows: readonly T[],
  names: readonly string[],
): T[] {
  if (!names.length) return [...rows]
  return rows.filter((row) => row.environments.some((env) => names.includes(env.name)))
}

/** A deploy status as a `Tag`: its words and tone. */
export function environmentTag(status: DeployStatus): { label: string; tone: StatusTone } {
  const { label, tone } = environmentStatus[status]
  return { label, tone: tone === 'none' ? 'default' : tone }
}

/**
 * One tick per name of `names` for a row: its deploy status there with the version that runs,
 * a neutral tick where the row has no such environment.
 */
export function environmentTicks(row: ReleaseBoardRow, names: readonly string[]): Tick[] {
  return names.map((name) => {
    const env = row.environments.find((candidate) => candidate.name === name)
    if (!env) return { tone: 'skipped', label: `${name}: not configured` }
    const { label, tone } = environmentStatus[env.status]
    const version = env.version ? ` · ${env.version}` : ''
    return { tone: tone === 'none' ? 'skipped' : tone, label: `${name}: ${label}${version}` }
  })
}

const pipelineWords: Record<PipelineState['status'], { label: string; tone: DotTone }> = {
  pending: { label: 'Pending', tone: 'info' },
  running: { label: 'Running', tone: 'info' },
  success: { label: 'Passed', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  canceled: { label: 'Canceled', tone: 'warning' },
  skipped: { label: 'Skipped', tone: 'none' },
  manual: { label: 'Manual', tone: 'none' },
}

/** The target branch pipeline in a word, "Not read" without one. */
export function targetPipeline(row: ReleaseBoardRow): { label: string; tone: DotTone } {
  const status = row.pipelines.target?.status
  return status ? pipelineWords[status] : { label: 'Not read', tone: 'none' }
}
