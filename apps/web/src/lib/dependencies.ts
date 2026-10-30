import type { DependencyInventory } from '@holtkeeper/api'

/** One library of the inventory. */
export type Library = DependencyInventory['libraries'][number]
/** How far a version is behind: `none`, `patch`, `minor` or `major`. */
export type Lag = Library['drift']

/** Which libraries to show. */
export type LibraryFilter = 'all' | 'drifting' | 'behind' | 'major'

/** Text and chip tone per lag, from up to date to a breaking version behind. */
export const lagTone = {
  none: 'success',
  patch: 'default',
  minor: 'warning',
  major: 'danger',
} as const satisfies Record<Lag, string>

export const lagLabel: Record<Lag, string> = {
  none: 'Latest',
  patch: 'Patch behind',
  minor: 'Minor behind',
  major: 'Major behind',
}

/**
 * Libraries matching a name query, an ecosystem (`*` for all), a filter, whether dev-only usages
 * count and, with `repo`, only usages of that repository (`forge:path`). Usages that drop out are
 * removed; libraries without usages left are skipped. Order is kept.
 */
export function filterLibraries(
  libraries: readonly Library[],
  options: {
    query?: string
    ecosystem?: string
    filter?: LibraryFilter
    includeDev?: boolean
    repo?: string
  },
): Library[] {
  const needle = options.query?.trim().toLowerCase() ?? ''
  return libraries.flatMap((library) => {
    if (needle && !library.name.toLowerCase().includes(needle)) return []
    if (options.ecosystem && options.ecosystem !== '*' && library.ecosystem !== options.ecosystem)
      return []
    const usages = library.usages.filter(
      (usage) =>
        (options.includeDev !== false || usage.kind !== 'dev') &&
        (!options.repo || usage.origin === options.repo),
    )
    if (!usages.length) return []
    const behind = usages.filter((usage) => usage.lag !== 'none').length
    const versions = new Set(usages.map((usage) => usage.version))
    const filter = options.filter ?? 'all'
    if (filter === 'drifting' && library.versions.length < 2) return []
    if (filter === 'behind' && behind === 0) return []
    if (filter === 'major' && !usages.some((usage) => usage.lag === 'major')) return []
    return [
      { ...library, usages, behind, versions: library.versions.filter((v) => versions.has(v)) },
    ]
  })
}

/** Usages per version, newest first, with the lag of that version. */
export function versionBreakdown(
  library: Library,
): { version: string; count: number; lag: Lag; repos: number }[] {
  const byVersion = Map.groupBy(library.usages, (usage) => usage.version)
  return library.versions.toReversed().flatMap((version) => {
    const usages = byVersion.get(version) ?? []
    if (!usages.length) return []
    return [
      {
        version,
        count: usages.length,
        lag: usages[0]?.lag ?? 'none',
        repos: new Set(usages.map((usage) => usage.origin)).size,
      },
    ]
  })
}

/** The cell of a library × repository matrix: the versions a repository uses, worst lag first. */
export interface MatrixCell {
  versions: { version: string; lag: Lag; workspaces: string[] }[]
}

const lagRank: Record<Lag, number> = { none: 0, patch: 1, minor: 2, major: 3 }

/** The worst lag among usages; `none` for none. */
export const worstLag = (lags: readonly Lag[]): Lag =>
  lags.reduce<Lag>((worst, lag) => (lagRank[lag] > lagRank[worst] ? lag : worst), 'none')

/** Matrix cells of one library keyed by repository (`forge:path`). */
export function matrixRow(library: Library): Map<string, MatrixCell> {
  const row = new Map<string, MatrixCell>()
  for (const usage of library.usages) {
    const cell = row.get(usage.origin) ?? { versions: [] }
    const entry = cell.versions.find((v) => v.version === usage.version)
    if (entry) entry.workspaces.push(usage.workspace)
    else
      cell.versions.push({ version: usage.version, lag: usage.lag, workspaces: [usage.workspace] })
    row.set(usage.origin, cell)
  }
  for (const cell of row.values()) cell.versions.sort((a, b) => lagRank[b.lag] - lagRank[a.lag])
  return row
}

/** Headline numbers of a filtered inventory. */
export function inventoryTotals(libraries: readonly Library[]) {
  return {
    libraries: libraries.length,
    drifting: libraries.filter((library) => library.versions.length > 1).length,
    major: libraries.filter((library) => library.usages.some((u) => u.lag === 'major')).length,
    behind: libraries.reduce((sum, library) => sum + library.behind, 0),
    usages: libraries.reduce((sum, library) => sum + library.usages.length, 0),
  }
}
