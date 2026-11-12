import type {
  DependencyApiChange,
  DependencyDetail,
  DependencyMergeRequest,
  DependencyRepo,
  DependencyRow,
  GroupMatch,
  UpgradeImpact,
} from '@holtkeeper/api'

import { type ScopeView, inHomeGroups, viewGroup } from './home-scope.ts'
import { parseEcosystem } from './libraries.ts'
import { repoKey } from './repo.ts'
import { searchEntry, searchEnum, searchText } from './search-params.ts'
import { type SortState, type SortValue, sortRows as sortTableRows } from './table-sort.ts'

type LibraryEcosystem = DependencyRow['ecosystem']

/** Words of an API change kind between two versions. */
export const apiChangeLabel: Record<DependencyApiChange['change'] | 'added', string> = {
  added: 'Added',
  removed: 'Removed',
  changed: 'Changed',
  deprecated: 'Deprecated',
}

/** Words of an update merge request's state. */
export const mergeRequestStatusLabel: Record<DependencyMergeRequest['status'], string> = {
  broken: 'Broken',
  open: 'Open',
  draft: 'Draft',
}

/** Which libraries to show: `all` is every third-party library, `internal` the organization's own. */
export type DependencyFilter = 'all' | 'behind' | 'advisories' | 'updates' | 'internal'

/** The segments of the Libraries table, in order. */
export const dependencyFilters: readonly { id: DependencyFilter; label: string }[] = [
  { id: 'all', label: 'Third-party' },
  { id: 'behind', label: 'Behind a major' },
  { id: 'advisories', label: 'Advisories' },
  { id: 'updates', label: 'Update MRs' },
  { id: 'internal', label: 'Internal' },
]

/** Tabs of a library page, in order. */
export const libraryTabs = [
  { id: 'overview', label: 'Overview' },
  { id: 'api', label: 'API' },
  { id: 'changes', label: 'Changes' },
  { id: 'used-by', label: 'Used by' },
  { id: 'upgrade', label: 'Upgrade' },
  { id: 'docs', label: 'Docs' },
] as const

export type LibraryTab = (typeof libraryTabs)[number]['id']

const sheetTabIds: readonly LibraryTab[] = ['overview', 'upgrade', 'used-by', 'docs']

/** Tabs of a library in the Libraries side sheet, in sheet order; the rest live on its page. */
export const librarySheetTabs: readonly { id: LibraryTab; label: string }[] = sheetTabIds.map(
  (id) => libraryTabs.find((tab) => tab.id === id)!,
)

/** A tab id from a URL value; anything unknown or not among `tabs` is `overview`. */
export const parseLibraryTab = (
  value: unknown,
  tabs: readonly { id: LibraryTab }[] = libraryTabs,
): LibraryTab => tabs.find((tab) => tab.id === value)?.id ?? 'overview'

/** Sortable columns of the Libraries table. */
export type LibrariesSortKey =
  | 'name'
  | 'ecosystem'
  | 'versions'
  | 'repos'
  | 'latest'
  | 'behind'
  | 'advisories'
  | 'updates'

const librariesSortKeys: readonly LibrariesSortKey[] = [
  'name',
  'ecosystem',
  'versions',
  'repos',
  'latest',
  'behind',
  'advisories',
  'updates',
]

/** Search parameters of `/supply/libraries`; omitted keys are the defaults. */
export interface LibrariesSearch {
  /** `forge:path` the table narrows to. */
  repo?: string
  /** The library open in the sheet, as `libraryKey` names it. */
  library?: string
  /** Tab of the open library's sheet. */
  tab?: string
  segment?: Exclude<DependencyFilter, 'all'>
  ecosystem?: LibraryEcosystem
  q?: string
  sort?: LibrariesSortKey
  dir?: 'asc' | 'desc'
}

/** Reads `/supply/libraries` search parameters, dropping unknown values and defaults. */
export function parseLibrariesSearch(search: Record<string, unknown>): LibrariesSearch {
  const segment = searchEnum(
    search.segment,
    dependencyFilters.map((filter) => filter.id),
  )
  const sort = searchEnum(search.sort, librariesSortKeys)
  return {
    ...searchEntry('repo', searchText(search.repo)),
    ...searchEntry('library', searchText(search.library)),
    ...searchEntry('tab', searchText(search.tab)),
    ...searchEntry('segment', segment === 'all' ? undefined : segment),
    ...searchEntry('ecosystem', parseEcosystem(search.ecosystem)),
    ...searchEntry('q', searchText(search.q)),
    ...(sort ? { sort, dir: search.dir === 'desc' ? ('desc' as const) : ('asc' as const) } : {}),
  }
}

/** The table sort `search` asks for; `null` keeps the server's order. */
export const librariesSort = (search: LibrariesSearch): SortState<LibrariesSortKey> =>
  search.sort ? { key: search.sort, direction: search.dir ?? 'asc' } : null

/** `search` with `sort` in it; `null` clears the sort back to the server's order. */
export function withLibrariesSort(
  search: LibrariesSearch,
  sort: SortState<LibrariesSortKey>,
): LibrariesSearch {
  const { sort: _sort, dir: _dir, ...rest } = search
  return sort ? { ...rest, sort: sort.key, dir: sort.direction } : rest
}

/** Search parameters of `/supply/libraries/<ecosystem>/<name>`; omitted keys are the defaults. */
export interface LibrarySearch {
  tab?: string
  /** Used by: the export whose code is shown. */
  export?: string
  /** Used by: `forge:path` everything narrows to. */
  repo?: string
  /** Used by: only consumers on this version. */
  using?: string
  /** API and Changes: the recorded version of an internal package shown (`head` for the default branch). */
  version?: string
  /** Upgrade and the header's roll-out: the version upgraded from. */
  from?: string
  /** Upgrade and the header's roll-out: the version upgraded to; the latest when absent. */
  to?: string
}

/** Reads library page search parameters, dropping empty values. */
export const parseLibrarySearch = (search: Record<string, unknown>): LibrarySearch => ({
  ...searchEntry('tab', searchText(search.tab)),
  ...searchEntry('export', searchText(search.export)),
  ...searchEntry('repo', searchText(search.repo)),
  ...searchEntry('using', searchText(search.using)),
  ...searchEntry('version', searchText(search.version)),
  ...searchEntry('from', searchText(search.from)),
  ...searchEntry('to', searchText(search.to)),
})

/** `npm:react`: how a library is named in the `library` search parameter. */
export const libraryKey = (row: { ecosystem: LibraryEcosystem; name: string }): string =>
  `${row.ecosystem}:${row.name}`

/** Reads `libraryKey` back; `undefined` for an unknown ecosystem or an empty name. */
export function parseLibraryKey(
  value: unknown,
): { ecosystem: LibraryEcosystem; name: string } | undefined {
  if (typeof value !== 'string') return undefined
  const separator = value.indexOf(':')
  const ecosystem = value.slice(0, separator)
  const name = value.slice(separator + 1)
  if (separator < 0 || !name || (ecosystem !== 'npm' && ecosystem !== 'Go')) return undefined
  return { ecosystem, name }
}

/**
 * The row as the accepted repositories see it: their uses, the versions they are on with
 * per-version repository counts, and the behind figures recomputed. `undefined` when none of
 * them uses the library. Advisories, licenses and Renovate state stay library-wide.
 */
export function narrowRow<T extends DependencyRow>(
  row: T,
  accept: (repo: string) => boolean,
): T | undefined {
  const usedBy = row.usedBy.filter((entry) => accept(entry.repo))
  if (!usedBy.length) return undefined
  if (usedBy.length === row.usedBy.length) return row
  const versions = row.versions.flatMap((entry) => {
    const repos = usedBy.filter((used) => used.versions.includes(entry.version)).length
    return repos ? [{ ...entry, repos }] : []
  })
  const behind = new Set(versions.filter((v) => v.majorsBehind > 0).map((v) => v.version))
  return {
    ...row,
    usedBy,
    versions,
    majorsBehind: Math.max(0, ...versions.map((v) => v.majorsBehind)),
    reposBehind: usedBy.filter((used) => used.versions.some((v) => behind.has(v))).length,
  }
}

interface RowFilter {
  query?: string
  /** `*` or absent for every ecosystem. */
  ecosystem?: string
  filter?: DependencyFilter
  /** `forge:path`: only libraries that repository uses, with its versions alone. */
  repo?: string
}

const matchesFilter = (row: DependencyRow, filter: DependencyFilter): boolean =>
  filter === 'internal'
    ? row.internal
    : !row.internal &&
      (filter === 'all' ||
        (filter === 'behind' && row.majorsBehind > 0) ||
        (filter === 'advisories' && row.advisories.count > 0) ||
        (filter === 'updates' && row.renovate !== 'none'))

function narrowTo<T extends DependencyRow>(
  rows: readonly T[],
  options: Omit<RowFilter, 'filter' | 'ecosystem'>,
): T[] {
  const needle = options.query?.trim().toLowerCase() ?? ''
  return rows.flatMap((row) => {
    if (needle && !row.name.toLowerCase().includes(needle)) return []
    const narrowed = options.repo ? narrowRow(row, (repo) => repo === options.repo) : row
    return narrowed ? [narrowed] : []
  })
}

const inEcosystem = (row: DependencyRow, ecosystem: string | undefined) =>
  !ecosystem || ecosystem === '*' || row.ecosystem === ecosystem

/**
 * Rows matching a name query, an ecosystem and a segment; every segment but `internal` leaves
 * internal packages out. With `repo`, rows narrow to that repository's versions before the
 * segment applies. Order is kept, extra fields too.
 */
export function filterRows<T extends DependencyRow>(rows: readonly T[], options: RowFilter): T[] {
  const filter = options.filter ?? 'all'
  return narrowTo(rows, options).filter(
    (row) => inEcosystem(row, options.ecosystem) && matchesFilter(row, filter),
  )
}

/**
 * What each segment and each ecosystem would show: segments count with the query, ecosystem and
 * repository applied, ecosystems with the query, segment and repository applied.
 */
export function filterCounts(
  rows: readonly DependencyRow[],
  options: RowFilter,
): { segments: Record<DependencyFilter, number>; ecosystems: Record<LibraryEcosystem, number> } {
  const narrowed = narrowTo(rows, options)
  const filter = options.filter ?? 'all'
  const segments: Record<DependencyFilter, number> = {
    all: 0,
    behind: 0,
    advisories: 0,
    updates: 0,
    internal: 0,
  }
  const ecosystems: Record<LibraryEcosystem, number> = { npm: 0, Go: 0 }
  for (const row of narrowed) {
    if (inEcosystem(row, options.ecosystem))
      for (const segment of dependencyFilters)
        if (matchesFilter(row, segment.id)) segments[segment.id] += 1
    if (matchesFilter(row, filter)) ecosystems[row.ecosystem] += 1
  }
  return { segments, ecosystems }
}

/** A library row with the groups `FleetTable` folds it by. */
export type LibraryFleetRow = DependencyRow & { groups: string[] }

/**
 * Library rows ready for `FleetTable`. Under *My teams* a library some home-group repository
 * uses is narrowed to those repositories and carries a home group's groups, and a library only
 * other teams use is narrowed to theirs and carries their groups, so the table folds it away.
 * A group position keeps the libraries that group's repositories use, narrowed to them. Under
 * *All I can see* rows stay whole. A UI default, not a permission.
 */
export function scopeLibraryRows(
  rows: readonly DependencyRow[],
  repos: readonly DependencyRepo[],
  view: ScopeView,
  homeGroups: readonly GroupMatch[],
): LibraryFleetRow[] {
  const groupsOf = new Map(repos.map((entry) => [repoKey(entry.repo), entry.groups]))
  const isMine = (repo: string) => inHomeGroups(homeGroups, groupsOf.get(repo) ?? [])
  const groupsFor = (row: DependencyRow) => {
    const mine = row.usedBy.find((used) => isMine(used.repo))
    if (mine) return groupsOf.get(mine.repo) ?? []
    return [...new Set(row.usedBy.flatMap((used) => groupsOf.get(used.repo) ?? []))].toSorted()
  }
  const group = viewGroup(view)
  if (group !== undefined)
    return rows.flatMap((row) => {
      const narrowed = narrowRow(row, (repo) => (groupsOf.get(repo) ?? []).includes(group))
      return narrowed ? [{ ...narrowed, groups: groupsFor(narrowed) }] : []
    })
  return rows.flatMap((row) => {
    if (view === 'all' || !homeGroups.length) return [{ ...row, groups: groupsFor(row) }]
    const usedByMine = row.usedBy.some((used) => isMine(used.repo))
    const narrowed = narrowRow(row, (repo) => isMine(repo) === usedByMine)
    return narrowed ? [{ ...narrowed, groups: groupsFor(narrowed) }] : []
  })
}

/** Figures of the summary strip over the rows in view. */
export function libraryTotals(rows: readonly DependencyRow[]): {
  libraries: number
  repos: number
  behindMajor: number
  withAdvisories: number
  renovateOpen: number
  renovateBroken: number
} {
  return {
    libraries: rows.length,
    repos: new Set(rows.flatMap((row) => row.usedBy.map((used) => used.repo))).size,
    behindMajor: rows.filter((row) => row.majorsBehind > 0).length,
    withAdvisories: rows.filter((row) => row.advisories.count > 0).length,
    renovateOpen: rows.filter((row) => row.renovate === 'open').length,
    renovateBroken: rows.filter((row) => row.renovate === 'broken').length,
  }
}

const renovateRank: Record<DependencyRow['renovate'], number> = { none: 0, open: 1, broken: 2 }

const librarySortValues: Record<LibrariesSortKey, (row: DependencyRow) => SortValue> = {
  name: (row) => row.name,
  ecosystem: (row) => row.ecosystem,
  versions: (row) => row.versions.length,
  repos: (row) => row.usedBy.length,
  latest: (row) => row.latest,
  behind: (row) => (row.latest ? row.majorsBehind * 10_000 + row.reposBehind : undefined),
  advisories: (row) => row.advisories.count,
  updates: (row) => renovateRank[row.renovate],
}

/** Rows sorted by a Libraries column; without a sort the order is kept. */
export const sortRows = <T extends DependencyRow>(
  rows: readonly T[],
  sort: SortState<LibrariesSortKey>,
): T[] => sortTableRows(rows, sort, (row, key) => librarySortValues[key](row))

const csvCell = (value: string | number): string => {
  const text = String(value)
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
}

/**
 * The rows as CSV with a header line, one library per line: versions in use with their
 * repository counts, latest, breaking releases behind, advisories, update MRs and licenses.
 * Cells a spreadsheet would run as a formula are prefixed with `'`.
 */
export function toCsv(rows: readonly DependencyRow[]): string {
  const header = [
    'Library',
    'Ecosystem',
    'Internal',
    'Versions in use',
    'Repositories',
    'Latest',
    'Majors behind',
    'Repositories behind',
    'Advisories',
    'Worst severity',
    'Update MRs',
    'Licenses',
  ]
  const lines = rows.map((row) => [
    row.name,
    row.ecosystem,
    row.internal ? 'yes' : 'no',
    row.versions.map((entry) => `${entry.version} x${entry.repos}`).join('; '),
    row.usedBy.length,
    row.latest ?? '',
    row.latest ? row.majorsBehind : '',
    row.latest ? row.reposBehind : '',
    row.advisories.count,
    row.advisories.severity ?? '',
    row.renovate === 'none' ? '' : row.renovate,
    row.licenses.join('; '),
  ])
  return [header, ...lines].map((line) => line.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

const compareVersions = (a: string, b: string): number =>
  a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' })

/**
 * The repositories a roll-out to `to` changes: those using the library at a version below `to`
 * (a repository with several versions counts when any of them is older), as `forge:path`.
 */
export const rolloutTargets = (
  repos: readonly { repo: string; versions: readonly string[] }[],
  to: string,
): string[] =>
  repos
    .filter((entry) => entry.versions.some((version) => compareVersions(version, to) < 0))
    .map((entry) => entry.repo)

/**
 * Versions the Upgrade tab offers: `from` the versions in use, lowest first; `to` the indexed
 * versions and the latest, highest first.
 */
export function upgradeVersions(
  detail: Pick<DependencyDetail, 'versions' | 'indexed' | 'latest'>,
): {
  from: string[]
  to: string[]
} {
  const to = new Set(detail.indexed.map((entry) => entry.version))
  if (detail.latest) to.add(detail.latest)
  return {
    from: detail.versions.map((entry) => entry.version),
    to: [...to].toSorted((a, b) => compareVersions(b, a)),
  }
}

/** Chip tone of a version by breaking releases behind the latest. */
export const behindTone = (majorsBehind: number) =>
  majorsBehind === 0 ? 'success' : majorsBehind === 1 ? 'warning' : 'danger'

/** "2 majors behind", "1 major behind" or "current". */
export const behindLabel = (majorsBehind: number): string =>
  majorsBehind === 0
    ? 'current'
    : `${majorsBehind} ${majorsBehind === 1 ? 'major' : 'majors'} behind`

/**
 * The impact as the accepted repositories see it: items and repositories outside them dropped,
 * counts recomputed, items left without a repository removed.
 */
export function narrowImpact(
  impact: UpgradeImpact,
  accept: (repo: string) => boolean,
): UpgradeImpact {
  const items = impact.items.flatMap((item) => {
    const repos = item.repos.filter((entry) => accept(entry.origin))
    if (!repos.length) return []
    return [{ ...item, repos, count: repos.reduce((sum, entry) => sum + entry.count, 0) }]
  })
  return {
    ...impact,
    items,
    affected: impact.affected.filter(accept),
    unaffected: impact.unaffected.filter(accept),
  }
}
