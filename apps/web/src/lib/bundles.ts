import type {
  BundlePoint,
  BundleSeries,
  BundlesOverview,
  BundleTargetRow,
  RepoRef,
  Section,
} from '@holtkeeper/api'

import { repoKey } from './repo.ts'
import { searchEntry, searchEnum, searchList, searchText } from './search-params.ts'
import type { SortState, SortValue } from './table-sort.ts'

/** Which size a bundle chart and table show. */
export type Compression = 'gzip' | 'brotli' | 'raw'

/** Entrypoints drawn as their own lines; with more, only the largest ones are. */
const MAX_ENTRY_LINES = 6

/** A point's short name: the package version, else the ref (commits shortened), else the date. */
export function pointLabel(point: BundlePoint): string {
  if (point.version) return point.version
  if (point.ref) return /^[0-9a-f]{40}$/.test(point.ref) ? point.ref.slice(0, 8) : point.ref
  return (point.at ?? point.measuredAt).slice(0, 10)
}

/** Search parameters that select a point: the version for packages, the record for builds. */
export const pointSearch = (point: BundlePoint) =>
  point.version ? { version: point.version } : { analysis: point.analysisId }

const lastOk = (points: BundlePoint[]) => points.findLast((point) => point.status === 'ok')

/** Entrypoints worth a line of their own: the largest by their newest initial size. */
export function chartEntrypoints(series: BundleSeries, compression: Compression): string[] {
  const newest = lastOk(series.points)
  const sizes = new Map<string, number>()
  for (const point of series.points)
    for (const entry of point.entrypoints ?? [])
      if (!sizes.has(entry.name) || point === newest)
        sizes.set(entry.name, entry.initial[compression])
  return [...sizes]
    .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_ENTRY_LINES)
    .map(([name]) => name)
}

/** One chart row per point; sizes of failed points are `null`, so lines show a gap. */
export interface ChartRow {
  key: string
  label: string
  /** Publish or build time, when known. */
  at?: string
  status: BundlePoint['status']
  total: number | null
  [entrypoint: `entry:${string}`]: number | null
}

/** Rows for the history chart of one target: total size and initial size per entrypoint. */
export function chartRows(
  series: BundleSeries,
  compression: Compression,
  entrypoints: string[],
): ChartRow[] {
  return series.points.map((point) => {
    const row: ChartRow = {
      key: point.version ?? point.analysisId,
      label: pointLabel(point),
      ...(point.at ? { at: point.at } : {}),
      status: point.status,
      total: point.total?.[compression] ?? null,
    }
    for (const name of entrypoints) {
      const entry = point.entrypoints?.find((item) => item.name === name)
      row[`entry:${name}`] = entry ? entry.initial[compression] : null
    }
    return row
  })
}

/** Change from the first to the newest measured point, for the chart's caption. */
export function overallChange(series: BundleSeries, compression: Compression) {
  const measured = series.points.filter((point) => point.status === 'ok')
  const first = measured[0]?.total?.[compression]
  const last = measured.at(-1)?.total?.[compression]
  if (first === undefined || last === undefined) return undefined
  return { first, last, delta: last - first, measured: measured.length }
}

/** One measured point of a target's history with its size and change against the measured point before. */
export interface HistoryRow {
  point: BundlePoint
  index: number
  size: number | undefined
  delta: number | undefined
}

/** The history table of one target: every point with its change, newest first. */
export function historyRows(series: BundleSeries, compression: Compression): HistoryRow[] {
  let before: number | undefined
  const rows = series.points.map((point, index): HistoryRow => {
    const size = point.status === 'ok' ? point.total?.[compression] : undefined
    const row = {
      point,
      index,
      size,
      delta: size !== undefined && before !== undefined ? size - before : undefined,
    }
    if (size !== undefined) before = size
    return row
  })
  return rows.toReversed()
}

/** Where a target stands: over, near or within its budget, without one, or not measured. */
export type BudgetState = 'over' | 'near' | 'ok' | 'none' | 'failed'

/** Every `BudgetState`, worst first. */
export const budgetStates = ['over', 'failed', 'near', 'ok', 'none'] as const

/** Words for each `BudgetState`. */
export const budgetStateLabel: Record<BudgetState, string> = {
  over: 'Over budget',
  near: 'Near budget',
  ok: 'Within budget',
  none: 'No budget',
  failed: 'Build failed',
}

/** Status tone of each `BudgetState`. */
export const budgetStateTone = {
  over: 'danger',
  near: 'warning',
  ok: 'success',
  none: 'default',
  failed: 'danger',
} as const satisfies Record<BudgetState, string>

/** Kinds of target: app builds and published packages. */
const targetKinds = ['build', 'package'] as const

/** One row of Quality › Bundles: a target of one repository's newest bundle records. */
export interface BundleRow extends BundleTargetRow {
  /** `forge:path` of the repository and the target name. */
  key: string
  repo: RepoRef
  repoKey: string
  groups: string[]
  /** Ref of the repository's newest record. */
  ref?: string
}

/** Key of the row of `target` in `repo`. */
export const bundleRowKey = (repo: string, target: string) => `${repo}#${target}`

/** One row per target of every repository on the overview. */
export function bundleRows(overview: BundlesOverview): BundleRow[] {
  return overview.repos.flatMap((entry) =>
    entry.targets.map((target) => {
      const key = repoKey(entry.repo)
      return {
        ...target,
        key: bundleRowKey(key, target.name),
        repo: entry.repo,
        repoKey: key,
        groups: entry.groups,
        ...(entry.ref ? { ref: entry.ref } : {}),
      }
    }),
  )
}

/** `BudgetState` of a target. */
export function budgetState(row: BundleTargetRow): BudgetState {
  if (row.status === 'failed') return 'failed'
  if (row.overBudget || row.verdict === 'over') return 'over'
  if (row.verdict === 'near') return 'near'
  if (row.verdict === 'ok') return 'ok'
  return 'none'
}

/** Gzip size as a share of the budget, `1` meaning exactly at it; absent without either. */
export const budgetShare = (row: BundleTargetRow): number | undefined =>
  row.gzip !== undefined && row.budget ? row.gzip / row.budget : undefined

/** The change against the previous measurement in percent of that measurement. */
export function deltaPercent(row: BundleTargetRow): number | undefined {
  if (row.delta === undefined || row.gzip === undefined) return undefined
  const before = row.gzip - row.delta
  return before > 0 ? (row.delta / before) * 100 : undefined
}

/** The release a row's newest measurement belongs to: the package version, else the record's ref. */
export const rowRelease = (row: BundleRow): string | undefined =>
  row.version ??
  (row.ref ? (/^[0-9a-f]{40}$/.test(row.ref) ? row.ref.slice(0, 8) : row.ref) : undefined)

/** Columns of the Bundles table a person can sort by. */
export type BundlesSortKey = 'target' | 'release' | 'size' | 'delta' | 'budget' | 'initial'

const sortKeys: readonly BundlesSortKey[] = [
  'target',
  'release',
  'size',
  'delta',
  'budget',
  'initial',
]

const sortValues: Record<BundlesSortKey, (row: BundleRow) => SortValue> = {
  target: (row) => `${row.name} ${row.repo.path}`,
  release: (row) => row.createdAt,
  size: (row) => row.gzip,
  delta: (row) => row.delta,
  budget: budgetShare,
  initial: (row) => row.initial,
}

/** What a column sorts a row by. */
export const bundleSortValue = (row: BundleRow, key: BundlesSortKey): SortValue =>
  sortValues[key](row)

/** Rows worst first: over budget, failed, near budget, then by budget used and size. */
export function worstFirst(rows: readonly BundleRow[]): BundleRow[] {
  const rank = (row: BundleRow) => budgetStates.indexOf(budgetState(row))
  return rows.toSorted(
    (a, b) =>
      rank(a) - rank(b) ||
      (budgetShare(b) ?? -1) - (budgetShare(a) ?? -1) ||
      (b.gzip ?? -1) - (a.gzip ?? -1) ||
      a.key.localeCompare(b.key),
  )
}

/** Figures of the Strip over the rows in scope. */
export interface BundleKpis {
  targets: number
  builds: number
  packages: number
  over: number
  near: number
  /** Targets whose newest measurement grew against the one before, and by how much in all. */
  grew: number
  grewBy: number
  failed: number
}

/** Strip figures over `rows`. */
export function bundleKpis(rows: readonly BundleTargetRow[]): BundleKpis {
  const grown = rows.filter((row) => row.status === 'ok' && (row.delta ?? 0) > 0)
  return {
    targets: rows.length,
    builds: rows.filter((row) => row.source === 'build').length,
    packages: rows.filter((row) => row.source === 'package').length,
    over: rows.filter((row) => budgetState(row) === 'over').length,
    near: rows.filter((row) => budgetState(row) === 'near').length,
    grew: grown.length,
    grewBy: grown.reduce((sum, row) => sum + (row.delta ?? 0), 0),
    failed: rows.filter((row) => row.status === 'failed').length,
  }
}

/** Tabs of the bundle sheet. */
export const bundleTabs = ['composition', 'entrypoints', 'packages', 'history'] as const

/** One tab of the bundle sheet. */
export type BundleTab = (typeof bundleTabs)[number]

const tabSections: Partial<Record<BundleTab, readonly string[]>> = {
  entrypoints: ['entrypoints'],
  packages: ['packages', 'package'],
}

/**
 * The report sections a sheet tab shows: Entrypoints and Packages their own sections, Composition
 * every other one (overview, composition, assets, …), History none.
 */
export function sheetSections(sections: readonly Section[], tab: BundleTab): Section[] {
  if (tab === 'history') return []
  const own = tabSections[tab]
  if (own) return sections.filter((section) => own.includes(section.id))
  const elsewhere = new Set(Object.values(tabSections).flat())
  return sections.filter((section) => !elsewhere.has(section.id))
}

/**
 * Search parameters of Quality › Bundles: `repo` (`forge:path`) narrows the table to one
 * repository, `q`, `kind` and `budget` filter it, `sort`/`dir` order it. The sheet shows target
 * `target` of repository `open` on tab `tab`, at a point of its history (`version` of a package
 * or `analysis` id of a build; the newest without either).
 */
export interface BundlesSearch {
  repo?: string
  q?: string
  kind?: (typeof targetKinds)[number][]
  budget?: BudgetState[]
  sort?: BundlesSortKey
  dir?: 'asc' | 'desc'
  open?: string
  target?: string
  tab?: BundleTab
  version?: string
  analysis?: string
}

/** `BundlesSearch` from raw search values; unknown and empty values are dropped. */
export function parseBundlesSearch(search: Record<string, unknown>): BundlesSearch {
  const sort = searchEnum(search.sort, sortKeys)
  return {
    ...searchEntry('repo', searchText(search.repo)),
    ...searchEntry('q', searchText(search.q)),
    ...searchEntry('kind', searchList(search.kind, targetKinds)),
    ...searchEntry('budget', searchList(search.budget, budgetStates)),
    ...(sort ? { sort, dir: search.dir === 'desc' ? ('desc' as const) : ('asc' as const) } : {}),
    ...searchEntry('open', searchText(search.open)),
    ...searchEntry('target', searchText(search.target)),
    ...searchEntry('tab', searchEnum(search.tab, bundleTabs)),
    ...searchEntry('version', searchText(search.version)),
    ...searchEntry('analysis', searchText(search.analysis)),
  }
}

/** The table sort a `BundlesSearch` names; `null` means worst first. */
export const bundlesSort = (search: BundlesSearch): SortState<BundlesSortKey> =>
  search.sort ? { key: search.sort, direction: search.dir ?? 'asc' } : null

/** Rows matching the repository, text, kind and budget filters of `search`. */
export function filterBundleRows(rows: readonly BundleRow[], search: BundlesSearch): BundleRow[] {
  const q = search.q?.trim().toLowerCase()
  return rows.filter(
    (row) =>
      (!search.repo || row.repoKey === search.repo) &&
      (!q || row.name.toLowerCase().includes(q) || row.repo.path.toLowerCase().includes(q)) &&
      (!search.kind?.length || search.kind.includes(row.source)) &&
      (!search.budget?.length || search.budget.includes(budgetState(row))),
  )
}
