import type {
  DependencyDetail,
  DependencyRepo,
  DependencyRow,
  GroupMatch,
  UpgradeImpact,
} from '@holtkeeper/api'

import { type ScopeView, inHomeGroups } from './home-scope.ts'
import { repoKey } from './repo.ts'

type LibraryEcosystem = DependencyRow['ecosystem']

/** Which libraries to show. */
export type DependencyFilter = 'all' | 'behind' | 'advisories' | 'updates' | 'internal'

/** Tabs of a library, in the sheet and on its own page. */
export const libraryTabs = [
  { id: 'overview', label: 'Overview' },
  { id: 'upgrade', label: 'Upgrade' },
  { id: 'docs', label: 'Docs' },
] as const

export type LibraryTab = (typeof libraryTabs)[number]['id']

/** A tab id from a URL value; anything unknown is `overview`. */
export const parseLibraryTab = (value: unknown): LibraryTab =>
  libraryTabs.find((tab) => tab.id === value)?.id ?? 'overview'

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
export function narrowRow(
  row: DependencyRow,
  accept: (repo: string) => boolean,
): DependencyRow | undefined {
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

/**
 * Rows matching a name query, an ecosystem (`*` for all) and a filter; `all`, `behind`,
 * `advisories` and `updates` leave internal packages out, `internal` shows only them. With `repo`
 * (`forge:path`), only libraries that repository uses, with its versions alone. Order is kept.
 */
export function filterRows(
  rows: readonly DependencyRow[],
  options: { query?: string; ecosystem?: string; filter?: DependencyFilter; repo?: string },
): DependencyRow[] {
  const needle = options.query?.trim().toLowerCase() ?? ''
  const filter = options.filter ?? 'all'
  return rows.flatMap((row) => {
    if (needle && !row.name.toLowerCase().includes(needle)) return []
    if (options.ecosystem && options.ecosystem !== '*' && row.ecosystem !== options.ecosystem)
      return []
    if ((filter === 'internal') !== row.internal) return []
    const narrowed = options.repo ? narrowRow(row, (repo) => repo === options.repo) : row
    if (!narrowed) return []
    if (filter === 'behind' && narrowed.majorsBehind === 0) return []
    if (filter === 'advisories' && narrowed.advisories.count === 0) return []
    if (filter === 'updates' && narrowed.renovate === 'none') return []
    return [narrowed]
  })
}

/** Rows a scope position shows, the switch counts and the folded "other teams" line. */
export interface ScopedRows {
  /** Narrowed to the home groups' repositories for *My team*; empty for *Other teams*. */
  shown: DependencyRow[]
  counts: Record<ScopeView, number>
  /** Repositories outside the home groups and the groups they are in. */
  others: { libraries: number; repos: number; teams: number }
}

/**
 * Splits library rows by the viewer's home groups through the repositories using them. A UI
 * default, not a permission: rows are what the viewer may already see.
 */
export function scopeRows(
  rows: readonly DependencyRow[],
  repos: readonly DependencyRepo[],
  view: ScopeView,
  homeGroups: readonly GroupMatch[],
): ScopedRows {
  const mine = new Set<string>()
  const otherRepos: DependencyRepo[] = []
  for (const entry of repos)
    if (inHomeGroups(homeGroups, entry.groups)) mine.add(repoKey(entry.repo))
    else otherRepos.push(entry)
  const homeNames = new Set(homeGroups.filter((entry) => typeof entry === 'string'))
  const teams = new Set(
    otherRepos.flatMap((entry) => entry.groups).filter((g) => !homeNames.has(g)),
  )
  const own = rows.flatMap((row) => narrowRow(row, (repo) => mine.has(repo)) ?? [])
  const othersCount = rows.filter((row) => row.usedBy.some((used) => !mine.has(used.repo))).length
  return {
    shown: view === 'mine' ? own : view === 'all' ? [...rows] : [],
    counts: { mine: own.length, all: rows.length, others: othersCount },
    others: { libraries: othersCount, repos: otherRepos.length, teams: teams.size },
  }
}

/**
 * Libraries only other teams use, narrowed to their repositories, with the groups they are in:
 * what the *My team* view folds into a collapsed "Other teams" section. Empty without home groups.
 */
export function otherTeamRows(
  rows: readonly DependencyRow[],
  repos: readonly DependencyRepo[],
  homeGroups: readonly GroupMatch[],
): { rows: DependencyRow[]; teams: string[] } {
  if (!homeGroups.length) return { rows: [], teams: [] }
  const mine = new Set(
    repos.filter((entry) => inHomeGroups(homeGroups, entry.groups)).map((e) => repoKey(e.repo)),
  )
  const groupsOf = new Map(repos.map((entry) => [repoKey(entry.repo), entry.groups]))
  const homeNames = new Set(
    homeGroups.flatMap((entry) => (typeof entry === 'string' ? [entry] : entry)),
  )
  const others = rows.flatMap((row) =>
    row.usedBy.some((used) => mine.has(used.repo))
      ? []
      : (narrowRow(row, (repo) => !mine.has(repo)) ?? []),
  )
  const teams = new Set(
    others.flatMap((row) => row.usedBy.flatMap((used) => groupsOf.get(used.repo) ?? [])),
  )
  return { rows: others, teams: [...teams].filter((team) => !homeNames.has(team)).toSorted() }
}

/** The three tiles over third-party rows: behind a major, with advisories, update MRs. */
export function tileCounts(rows: readonly DependencyRow[]): {
  behindMajor: number
  withAdvisories: number
  renovateOpen: number
  renovateBroken: number
} {
  const external = rows.filter((row) => !row.internal)
  return {
    behindMajor: external.filter((row) => row.majorsBehind > 0).length,
    withAdvisories: external.filter((row) => row.advisories.count > 0).length,
    renovateOpen: external.filter((row) => row.renovate === 'open').length,
    renovateBroken: external.filter((row) => row.renovate === 'broken').length,
  }
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
