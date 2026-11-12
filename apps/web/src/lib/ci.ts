import type {
  CiJobOutcomes,
  CiJobStats,
  CiJobsData,
  CiProblem,
  CiProblemKind,
  CiReleaseGate,
  CiRepoCard,
  CiStatus,
} from '@holtkeeper/api'

import type { StatusTone } from '../ui/colors.ts'
import type { Segment } from '../ui/SegmentBar.tsx'
import { formatDuration } from './format.ts'
import { repoKey } from './repo.ts'
import { searchEntry, searchEnum, searchList, searchText } from './search-params.ts'
import { defined, median } from './stats.ts'
import type { SortState, SortValue } from './table-sort.ts'

/** `3 min 5 s` from seconds; `—` when unknown. */
export const seconds = (value: number | undefined | null): string =>
  value === undefined || value === null ? '—' : formatDuration(value * 1000)

/** Tone of a failure rate: under 5% fine, under 15% a warning, above that bad. */
export const failureTone = (rate: number | undefined): StatusTone =>
  rate === undefined || rate < 5 ? 'success' : rate < 15 ? 'warning' : 'danger'

/** Tone of a success rate, the mirror of `failureTone`. */
export const successTone = (rate: number | undefined): StatusTone =>
  rate === undefined ? 'default' : failureTone(100 - rate)

/** Tone of each problem kind. */
export const problemTones: Record<CiProblemKind, StatusTone> = {
  failing: 'danger',
  slower: 'warning',
  flaky: 'warning',
}

/**
 * A pipeline time change as an arrow and percent: `↑ 12%` is slower and reads as bad, `↓ 8%`
 * faster and good; changes under 5% stay neutral.
 */
export function changeLabel(change: number | undefined): { text: string; tone: StatusTone } {
  if (change === undefined) return { text: '', tone: 'default' }
  const rounded = Math.round(change)
  if (rounded === 0) return { text: '± 0%', tone: 'default' }
  const tone = Math.abs(change) < 5 ? 'default' : change > 0 ? 'danger' : 'success'
  return { text: `${rounded > 0 ? '↑' : '↓'} ${Math.abs(rounded)}%`, tone }
}

/** Jobs that failed or passed only on retry, worst failure rate first. */
export const unreliableJobs = (jobs: readonly CiJobStats[]): CiJobStats[] =>
  jobs
    .filter((job) => job.failures > 0 || job.flaky > 0)
    .toSorted(
      (a, b) =>
        (b.failureRate ?? 0) - (a.failureRate ?? 0) ||
        b.flaky - a.flaky ||
        a.name.localeCompare(b.name),
    )

/** CI states, worst first. */
export const ciStatuses = [
  'failing',
  'flaky',
  'slower',
  'healthy',
  'idle',
] as const satisfies readonly CiStatus[]

/** CI states in words. */
export const ciStatusLabel: Record<CiStatus, string> = {
  failing: 'Failing',
  flaky: 'Flaky',
  slower: 'Slower',
  healthy: 'Healthy',
  idle: 'Idle',
}

/** Status tone of a CI state. */
export const ciStatusTone: Record<CiStatus, StatusTone> = {
  failing: 'danger',
  flaky: 'warning',
  slower: 'warning',
  healthy: 'success',
  idle: 'default',
}

/** CI problem kinds in words. */
export const problemLabel: Record<CiProblemKind, string> = {
  failing: 'Failing',
  flaky: 'Flaky',
  slower: 'Slower',
}

const statusRank = (status: CiStatus) => ciStatuses.indexOf(status)

/** Default order of the CI table: worst state first, then lowest success rate, then path. */
export const worstCiFirst = <T extends Pick<CiRepoCard, 'repo' | 'status' | 'successRate'>>(
  cards: readonly T[],
): T[] =>
  cards.toSorted(
    (a, b) =>
      statusRank(a.status) - statusRank(b.status) ||
      (a.successRate ?? 101) - (b.successRate ?? 101) ||
      repoKey(a.repo).localeCompare(repoKey(b.repo)),
  )

/** Headline figures of the CI rows in scope. Durations are seconds. */
export interface CiKpis {
  repos: number
  /** Medians over the repositories' medians and p90s. */
  median?: number
  p90?: number
  /** Success rate over every pipeline of the rows, percent rounded to 0.1. */
  successRate?: number
  flakyJobs: number
  queueMedian?: number
  statuses: Record<CiStatus, number>
}

/** `CiKpis` of `cards`. */
export function ciKpis(cards: readonly CiRepoCard[]): CiKpis {
  const statuses: Record<CiStatus, number> = {
    failing: 0,
    flaky: 0,
    slower: 0,
    healthy: 0,
    idle: 0,
  }
  for (const card of cards) statuses[card.status] += 1
  const rated = cards.filter((card) => card.successRate !== undefined && card.pipelines > 0)
  const pipelines = rated.reduce((sum, card) => sum + card.pipelines, 0)
  const passed = rated.reduce(
    (sum, card) => sum + ((card.successRate ?? 0) * card.pipelines) / 100,
    0,
  )
  const medianTime = median(defined(cards.map((card) => card.median)))
  const p90 = median(defined(cards.map((card) => card.p90)))
  const queueMedian = median(defined(cards.map((card) => card.queueMedian)))
  return {
    repos: cards.length,
    ...(medianTime === undefined ? {} : { median: medianTime }),
    ...(p90 === undefined ? {} : { p90 }),
    ...(pipelines ? { successRate: Math.round((passed / pipelines) * 1000) / 10 } : {}),
    flakyJobs: cards.reduce((sum, card) => sum + card.flakyJobs, 0),
    ...(queueMedian === undefined ? {} : { queueMedian }),
    statuses,
  }
}

/** Columns of the CI table that sort. */
const ciSortKeys = [
  'repo',
  'status',
  'median',
  'change',
  'p90',
  'success',
  'flaky',
  'queue',
  'pipelines',
  'last',
] as const

/** A column the CI table sorts by. */
export type CiSortKey = (typeof ciSortKeys)[number]

const sortValues: Record<CiSortKey, (card: CiRepoCard) => SortValue> = {
  repo: (card) => repoKey(card.repo),
  status: (card) => statusRank(card.status),
  median: (card) => card.median,
  change: (card) => card.change,
  p90: (card) => card.p90,
  success: (card) => card.successRate,
  flaky: (card) => card.flakyJobs,
  queue: (card) => card.queueMedian,
  pipelines: (card) => card.pipelines,
  last: (card) => (card.lastRunAt ? new Date(card.lastRunAt) : undefined),
}

/** What a column sorts a card by. */
export const ciSortValue = (card: CiRepoCard, key: CiSortKey): SortValue => sortValues[key](card)

/**
 * Search parameters of Quality › CI: `repo` (`forge:path`) opens one repository's sheet; `q`,
 * `status` and `problems` filter the table; `sort` and `dir` order it (worst first without).
 */
export interface CiSearch {
  repo?: string
  q?: string
  status?: CiStatus[]
  problems?: true
  sort?: CiSortKey
  dir?: 'asc' | 'desc'
}

/** `CiSearch` from raw search values; unknown and empty values are dropped. */
export function parseCiSearch(search: Record<string, unknown>): CiSearch {
  const sort = searchEnum(search.sort, ciSortKeys)
  return {
    ...searchEntry('repo', searchText(search.repo)),
    ...searchEntry('q', searchText(search.q)),
    ...searchEntry('status', searchList(search.status, ciStatuses)),
    ...(search.problems === true || search.problems === 'true' ? { problems: true as const } : {}),
    ...(sort ? { sort, dir: search.dir === 'desc' ? ('desc' as const) : ('asc' as const) } : {}),
  }
}

/** The table sort a `CiSearch` names. */
export const ciSort = (search: CiSearch): SortState<CiSortKey> =>
  search.sort ? { key: search.sort, direction: search.dir ?? 'asc' } : null

/** `search` with `sort` in it; `null` goes back to worst first. */
export function withCiSort(search: CiSearch, sort: SortState<CiSortKey>): CiSearch {
  const { sort: _sort, dir: _dir, ...rest } = search
  return sort ? { ...rest, sort: sort.key, dir: sort.direction } : rest
}

/** The cards `search` keeps: path or group text, states (any of), only those with problem jobs. */
export function filterCiCards<T extends CiRepoCard>(cards: readonly T[], search: CiSearch): T[] {
  const needle = search.q?.trim().toLowerCase()
  return cards.filter(
    (card) =>
      (!needle ||
        repoKey(card.repo).toLowerCase().includes(needle) ||
        card.groups.some((group) => group.toLowerCase().includes(needle))) &&
      (!search.status?.length || search.status.includes(card.status)) &&
      (!search.problems || card.problems > 0),
  )
}

/** One bar of the job-duration chart: a job with its median and p90 as shares of the slowest p90. */
export interface StageBar {
  stage: string
  /** Whether this is the stage's first job, which carries the stage label. */
  first: boolean
  job: string
  median: number | undefined
  p90: number | undefined
  /** Widths in percent of the chart, 0..100. */
  medianWidth: number
  p90Width: number
  flags: CiProblemKind[]
}

/** Jobs as duration bars grouped by stage in run order, unknown stages last. */
export function stageBars(
  data: Pick<CiJobsData, 'stages' | 'jobs'>,
  flags: Readonly<Record<string, readonly CiProblemKind[]>>,
): StageBar[] {
  const scale = Math.max(0, ...data.jobs.map((job) => job.duration.p90 ?? job.duration.median ?? 0))
  const width = (value: number | undefined) =>
    value === undefined || scale === 0 ? 0 : Math.min(100, Math.round((value / scale) * 100))
  const stages = [...new Set(data.jobs.map((job) => job.stage))]
  const order = [
    ...data.stages.filter((stage) => stages.includes(stage)),
    ...stages.filter((stage) => !data.stages.includes(stage)),
  ]
  return order.flatMap((stage) =>
    data.jobs
      .filter((job) => job.stage === stage)
      .map((job, index) => ({
        stage,
        first: index === 0,
        job: job.name,
        median: job.duration.median,
        p90: job.duration.p90,
        medianWidth: width(job.duration.median),
        p90Width: width(job.duration.p90 ?? job.duration.median),
        flags: [...(flags[job.name] ?? [])],
      })),
  )
}

/** Passed, failed and canceled counts as a `SegmentBar` with a caption like "Passed 355 · 86.2%". */
export function outcomeBar(outcomes: CiJobOutcomes | undefined):
  | {
      segments: Segment[]
      label: string
    }
  | undefined {
  if (!outcomes) return undefined
  const total = outcomes.success + outcomes.failed + outcomes.canceled
  if (!total) return undefined
  const share = Math.round((outcomes.success / total) * 1000) / 10
  return {
    segments: [
      { value: outcomes.success, tone: 'success', label: 'passed' },
      { value: outcomes.failed, tone: 'danger', label: 'failed' },
      { value: outcomes.canceled, tone: 'default', label: 'canceled' },
    ],
    label: `Passed ${outcomes.success} · ${share}% · Failed ${outcomes.failed} · Canceled ${outcomes.canceled}`,
  }
}

/** Jobs flagged with a problem kind the short problem list leaves out, by job name. */
export const moreFlagged = (
  flags: Readonly<Record<string, readonly CiProblemKind[]>>,
  problems: readonly Pick<CiProblem, 'job' | 'kind'>[],
): { job: string; kinds: CiProblemKind[] }[] =>
  Object.entries(flags)
    .map(([job, kinds]) => ({
      job,
      kinds: kinds.filter(
        (kind) => !problems.some((problem) => problem.job === job && problem.kind === kind),
      ),
    }))
    .filter((entry) => entry.kinds.length > 0)
    .toSorted((a, b) => a.job.localeCompare(b.job))

/** The release-gate fact in words, e.g. "Pipeline must pass on main". */
export const releaseGateText = (gate: CiReleaseGate): string =>
  gate.pipeline
    ? `Pipeline must pass on ${gate.branch}`
    : `Releases do not wait for the pipeline on ${gate.branch}`
