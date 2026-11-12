import type { CoverageRepoCard, RepoCoverageTests, RepoRef, SettingList } from '@holtkeeper/api'

import type { StatusTone } from '../ui/colors.ts'
import type { Segment } from '../ui/SegmentBar.tsx'
import {
  type Freshness,
  compareFreshness,
  freshnessLabel,
  freshnessOf,
  freshnessTone,
} from './freshness.ts'
import { type GroupTitleOf, groupMatchesQuery, keyAsTitle } from './group-titles.ts'
import { repoKey } from './repo.ts'
import { searchEntry, searchEnum, searchList, searchText } from './search-params.ts'
import { defined, median } from './stats.ts'
import type { SortState, SortValue } from './table-sort.ts'

interface Counts {
  covered: number
  total: number
}

/** Line coverage from which a share reads as good, and below which it reads as bad. */
const thresholds = { good: 80, bad: 50 }

/** Line coverage a repository should reach when no `analyzers.coverage` entry sets `target`. */
const defaultCoverageTarget = 60

/** The setting key holding the coverage analyzer's options. */
export const coverageSetting = 'analyzers.coverage'

/** Share covered, 0..100; `undefined` when there is nothing to cover. */
export const percentOf = (counts: Counts | undefined): number | undefined =>
  counts && counts.total > 0 ? (counts.covered / counts.total) * 100 : undefined

/** Tone of a coverage share, as the coverage report colors it. */
export function coverageTone(percent: number | undefined): StatusTone {
  if (percent === undefined) return 'default'
  if (percent >= thresholds.good) return 'success'
  return percent >= thresholds.bad ? 'warning' : 'danger'
}

/** A share as `87.5%`, or `—` when there is nothing to cover. */
export const formatPercent = (percent: number | undefined): string =>
  percent === undefined ? '—' : `${Math.round(percent * 10) / 10}%`

/** A change in points as `+2.5 pt` or `−1 pt`; empty for no change. */
export function formatPoints(points: number | undefined): string {
  if (points === undefined || Math.abs(points) < 0.05) return ''
  const rounded = Math.round(Math.abs(points) * 10) / 10
  return `${points > 0 ? '+' : '−'}${rounded} pt`
}

/** Tone of a change in points: gains good, losses bad. */
export const pointsTone = (points: number | undefined): StatusTone =>
  points === undefined || Math.abs(points) < 0.05 ? 'default' : points > 0 ? 'success' : 'danger'

/**
 * Lines to cover split into covered, uncovered in tested files and in files no test loaded, for a
 * `SegmentBar`.
 */
export function lineSegments(totals: CoverageRepoCard['totals']): Segment[] {
  const uncovered = totals.lines.total - totals.lines.covered
  const untested = Math.min(totals.untestedLines, uncovered)
  return [
    { value: totals.lines.covered, tone: 'success', label: 'covered lines' },
    { value: uncovered - untested, tone: 'warning', label: 'uncovered lines' },
    { value: untested, tone: 'danger', label: 'lines in files without tests' },
  ]
}

/** A coverage target from an option value: a number or numeric string from 0 to 100, else 60. */
export function coverageTargetOf(value: unknown): number {
  const target =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : Number.NaN
  return Number.isFinite(target) && target >= 0 && target <= 100 ? target : defaultCoverageTarget
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const optionOf = (value: unknown, option: string): unknown =>
  isRecord(value) ? value[option] : undefined

/**
 * The coverage target every repository gets unless a narrower entry overrides it: the `target` of
 * the `analyzers.coverage` entry scoped to everything, else the setting's default, else 60.
 */
export function orgCoverageTarget(
  settings: Pick<SettingList, 'settings' | 'definitions'> | undefined,
): number {
  const entry = settings?.settings.find((item) => item.key === coverageSetting && item.scope.all)
  if (entry && optionOf(entry.value, 'target') !== undefined)
    return coverageTargetOf(optionOf(entry.value, 'target'))
  const definition = settings?.definitions.find((item) => item.key === coverageSetting)
  return coverageTargetOf(optionOf(definition?.default, 'target'))
}

/** The `target` option of a resolved `analyzers.coverage` value; `fallback` when it sets none. */
export const resolvedCoverageTarget = (value: unknown, fallback: number): number =>
  optionOf(value, 'target') === undefined ? fallback : coverageTargetOf(optionOf(value, 'target'))

/** Exclude globs of an `analyzers.coverage` value: a list or a comma-separated string. */
export function coverageExcludes(value: unknown): string[] {
  const raw = optionOf(value, 'exclude')
  const list = typeof raw === 'string' ? raw.split(',') : Array.isArray(raw) ? raw : []
  return [
    ...new Set(
      list.flatMap((item) => (typeof item === 'string' && item.trim() ? [item.trim()] : [])),
    ),
  ]
}

/** One repository on the coverage table: its newest coverage record, or none yet. */
export interface CoverageRow {
  repo: RepoRef
  groups: readonly string[]
  card?: CoverageRepoCard
  /** Set when the repository has no tests by design (`repo.tests`). */
  noTests?: { reason?: string }
}

/**
 * Every repository with a coverage record plus every other readable repository as "Not
 * measured", lowest line coverage first, records without lines to cover next, unmeasured after
 * them and repositories with no tests by design (`noTests` of the repository list) last.
 */
export function coverageRows(
  cards: readonly CoverageRepoCard[],
  repos: readonly { repo: RepoRef; groups: readonly string[]; noTests?: { reason?: string } }[],
): CoverageRow[] {
  const measured = new Set(cards.map((card) => repoKey(card.repo)))
  const noTests = new Map(
    repos.flatMap((summary) => (summary.noTests ? [[repoKey(summary.repo), summary.noTests]] : [])),
  )
  const withNoTests = (row: CoverageRow): CoverageRow => {
    const marked = noTests.get(repoKey(row.repo))
    return marked ? { ...row, noTests: marked } : row
  }
  const rows: CoverageRow[] = [
    ...cards.map((card) => withNoTests({ repo: card.repo, groups: card.groups, card })),
    ...repos
      .filter((summary) => !measured.has(repoKey(summary.repo)))
      .map((summary) => withNoTests({ repo: summary.repo, groups: summary.groups })),
  ]
  const rank = (row: CoverageRow) => (row.noTests ? 103 : row.card ? (lineShare(row) ?? 101) : 102)
  return rows.toSorted(
    (a, b) => rank(a) - rank(b) || repoKey(a.repo).localeCompare(repoKey(b.repo)),
  )
}

const lineShare = (row: CoverageRow) =>
  row.noTests ? undefined : percentOf(row.card?.totals.lines)
const branchShare = (row: CoverageRow) =>
  row.noTests ? undefined : percentOf(row.card?.totals.branches)

/** How current a coverage row is: `no-tests` for a repository with no tests by design. */
type CoverageFreshness = Freshness | 'no-tests'

/** How current a row's record is; `never` without one, `no-tests` with no tests by design. */
export const coverageFreshness = (row: CoverageRow, now: Date = new Date()): CoverageFreshness =>
  row.noTests ? 'no-tests' : row.card ? freshnessOf(row.card, row.card.head, now) : 'never'

/** Freshness labels on coverage pages: a repository without a record reads "Not measured". */
export const coverageFreshnessLabel: Record<CoverageFreshness, string> = {
  ...freshnessLabel,
  never: 'Not measured',
  'no-tests': 'No tests by design',
}

/** Tag tones of `coverageFreshness` states. */
export const coverageFreshnessTone: Record<CoverageFreshness, StatusTone> = {
  ...freshnessTone,
  'no-tests': 'default',
}

/**
 * Whether a measured row's line coverage is under its repository's own target, else `target`;
 * unmeasured rows and rows with no tests by design never are.
 */
export const belowTarget = (row: CoverageRow, target: number): boolean => {
  const lines = lineShare(row)
  return lines !== undefined && lines < (row.card?.target ?? target)
}

/** Headline figures of the coverage rows in scope. */
export interface CoverageKpis {
  /** Rows of repositories meant to have tests. */
  repos: number
  measured: number
  medianLines?: number
  medianBranches?: number
  below: number
  untested: number
  /** Rows of repositories with no tests by design, left out of every other figure. */
  noTests: number
  freshness: Record<'current' | 'behind' | 'aging' | 'stale' | 'never', number>
}

/** `CoverageKpis` of `rows` against `target`; medians over measured rows that expect tests only. */
export function coverageKpis(
  rows: readonly CoverageRow[],
  target: number,
  now: Date = new Date(),
): CoverageKpis {
  const tested = rows.filter((row) => !row.noTests)
  const freshness = { current: 0, behind: 0, aging: 0, stale: 0, never: 0 }
  for (const row of tested) {
    const state = coverageFreshness(row, now)
    if (state !== 'failed' && state !== 'no-tests') freshness[state] += 1
  }
  const medianLines = median(defined(tested.map(lineShare)))
  const medianBranches = median(defined(tested.map(branchShare)))
  return {
    repos: tested.length,
    measured: tested.filter((row) => row.card).length,
    ...(medianLines === undefined ? {} : { medianLines }),
    ...(medianBranches === undefined ? {} : { medianBranches }),
    below: tested.filter((row) => belowTarget(row, target)).length,
    untested: tested.reduce((sum, row) => sum + (row.card?.totals.untested ?? 0), 0),
    noTests: rows.length - tested.length,
    freshness,
  }
}

/** Line coverage of a record's trend, oldest first, for a sparkline; `null` where unknown. */
export const trendValues = (card: Pick<CoverageRepoCard, 'trend'>): (number | null)[] =>
  card.trend.map((point) => point.lines ?? null)

/** Freshness states the Freshness filter offers. */
export const coverageFreshnessStates = [
  'current',
  'behind',
  'aging',
  'stale',
  'never',
  'no-tests',
] as const

type FreshnessFilter = (typeof coverageFreshnessStates)[number]

/** Columns of the coverage table that sort. */
const coverageSortKeys = ['repo', 'lines', 'branches', 'change', 'untested', 'freshness'] as const

/** A column the coverage table sorts by. */
export type CoverageSortKey = (typeof coverageSortKeys)[number]

/**
 * Search parameters of Quality › Coverage: `repo` (`forge:path`) opens one repository's sheet;
 * `q`, `freshness` and `below` filter the table; `sort` and `dir` order it (lowest line
 * coverage first without).
 */
export interface CoverageSearch {
  repo?: string
  q?: string
  freshness?: FreshnessFilter[]
  below?: true
  sort?: CoverageSortKey
  dir?: 'asc' | 'desc'
}

/** `CoverageSearch` from raw search values; unknown and empty values are dropped. */
export function parseCoverageSearch(search: Record<string, unknown>): CoverageSearch {
  const sort = searchEnum(search.sort, coverageSortKeys)
  return {
    ...searchEntry('repo', searchText(search.repo)),
    ...searchEntry('q', searchText(search.q)),
    ...searchEntry('freshness', searchList(search.freshness, coverageFreshnessStates)),
    ...(search.below === true || search.below === 'true' ? { below: true as const } : {}),
    ...(sort ? { sort, dir: search.dir === 'desc' ? ('desc' as const) : ('asc' as const) } : {}),
  }
}

/** The table sort a `CoverageSearch` names. */
export const coverageSort = (search: CoverageSearch): SortState<CoverageSortKey> =>
  search.sort ? { key: search.sort, direction: search.dir ?? 'asc' } : null

/** `search` with `sort` in it; `null` goes back to lowest coverage first. */
export function withCoverageSort(
  search: CoverageSearch,
  sort: SortState<CoverageSortKey>,
): CoverageSearch {
  const { sort: _sort, dir: _dir, ...rest } = search
  return sort ? { ...rest, sort: sort.key, dir: sort.direction } : rest
}

/** The rows `search` keeps: path or group title or key, freshness states, below target. */
export function filterCoverageRows(
  rows: readonly CoverageRow[],
  search: CoverageSearch,
  target: number,
  titleOf: GroupTitleOf = keyAsTitle,
  now: Date = new Date(),
): CoverageRow[] {
  const needle = search.q?.trim().toLowerCase()
  return rows.filter(
    (row) =>
      (!needle ||
        repoKey(row.repo).toLowerCase().includes(needle) ||
        row.groups.some((group) => groupMatchesQuery(group, titleOf, needle))) &&
      (!search.freshness?.length ||
        search.freshness.some((state) => state === coverageFreshness(row, now))) &&
      (!search.below || belowTarget(row, target)),
  )
}

/** What a column sorts a row by; unmeasured rows and rows with no tests by design stay last. */
export function coverageSortValue(
  row: CoverageRow,
  key: CoverageSortKey,
  now: Date = new Date(),
): SortValue {
  if (key === 'repo') return repoKey(row.repo)
  if (row.noTests) return undefined
  if (key === 'lines') return lineShare(row)
  if (key === 'branches') return branchShare(row)
  if (key === 'change') return row.card?.change
  if (key === 'untested') return row.card?.totals.untested
  const state = coverageFreshness(row, now)
  return state === 'never' || state === 'no-tests' ? undefined : compareFreshness(state, 'failed')
}

/**
 * What the `repo.tests` quick toggle on one repository does; `entryId` names the repository's own
 * entry, which a write updates instead of adding another.
 */
type TestsToggle =
  | { kind: 'mark'; entryId?: string }
  | { kind: 'remove'; entryId: string }
  | { kind: 'override'; entryId?: string; overrides?: RepoCoverageTests['scope'] }

/**
 * The quick toggle a person who may change `repo.tests` gets, or `undefined` otherwise: `mark`
 * (turn tests off on the repository's own entry) while tests are expected, `remove` when dropping
 * the own entry brings tests back, and `override` (turn them on in the own entry) when a broader
 * entry would still turn them off.
 */
export function testsToggle(tests: RepoCoverageTests | undefined): TestsToggle | undefined {
  if (!tests?.configurable) return undefined
  const own = tests.entryId ? { entryId: tests.entryId } : {}
  if (tests.expected) return { kind: 'mark', ...own }
  if (tests.entryId && tests.inherited) return { kind: 'remove', entryId: tests.entryId }
  return { kind: 'override', ...own, ...(tests.scope && { overrides: tests.scope }) }
}

/** The `repo.tests` entry value the toggle writes for one repository. */
export const testsEntryValue = (expected: boolean, reason?: string) =>
  expected || !reason?.trim() ? { expected } : { expected, reason: reason.trim() }
