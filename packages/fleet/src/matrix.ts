import { compareVersionText, type Lag, lagOf, parseVersion } from './semver.ts'
import type { FleetData, TrackedLibrary } from './types.ts'

/** What one repository uses of one library: its oldest version and every version it declares. */
export interface MatrixCell {
  version?: string
  lag: Lag
  /** Distinct versions across the repository's manifests, oldest first. */
  versions: string[]
  manifests: string[]
}

/** How one library is spread across the fleet. */
export interface LibrarySummary {
  id: string
  library: TrackedLibrary
  /** Cells by repository path; repositories without the library are absent. */
  cells: Map<string, MatrixCell>
  /** Distinct versions in use, oldest first. */
  versions: string[]
  /** Distinct major versions in use, ascending. */
  majors: number[]
  /** Repositories whose oldest version is on the lowest major, when more than one major is in use. */
  reposOnOldest: string[]
  /** Repositories at least one major behind the latest release. */
  reposBehindMajor: string[]
}

/** Stable id of a library across records, e.g. `npm:react`. */
export const libraryId = (library: Pick<TrackedLibrary, 'ecosystem' | 'name'>) =>
  `${library.ecosystem}:${library.name}`

const unique = (values: string[]) => [...new Set(values)].toSorted(compareVersionText)

/** Per-repository cells and fleet-wide spread of one tracked library. */
export function summarizeLibrary(library: TrackedLibrary): LibrarySummary {
  const cells = new Map<string, MatrixCell>()
  for (const [repo, usages] of Map.groupBy(library.usages, (usage) => usage.repo)) {
    const versions = unique(usages.map((usage) => usage.version).filter((v) => v !== undefined))
    const version = versions[0]
    cells.set(repo, {
      ...(version ? { version } : {}),
      lag: lagOf(version, library.latest),
      versions,
      manifests: usages.map((usage) => usage.manifest),
    })
  }
  const versions = unique([...cells.values()].flatMap((cell) => cell.versions))
  const majors = [
    ...new Set(
      versions.map((version) => parseVersion(version)?.major).filter((m) => m !== undefined),
    ),
  ].toSorted((a, b) => a - b)
  const oldest = majors[0]
  const reposOnOldest =
    majors.length > 1
      ? [...cells]
          .filter(([, cell]) => cell.version && parseVersion(cell.version)?.major === oldest)
          .map(([repo]) => repo)
          .toSorted()
      : []
  const reposBehindMajor = [...cells]
    .filter(([, cell]) => cell.lag === 'major')
    .map(([repo]) => repo)
    .toSorted()
  return {
    id: libraryId(library),
    library,
    cells,
    versions,
    majors,
    reposOnOldest,
    reposBehindMajor,
  }
}

/** Headline numbers of a fleet analysis. */
export interface FleetTotals {
  repos: number
  libraries: number
  multiMajor: number
  reposBehindMajor: number
  drifted: number
  missing: number
}

export function fleetTotals(data: FleetData): FleetTotals {
  const summaries = data.libraries.map(summarizeLibrary)
  return {
    repos: data.repos.filter((repo) => !repo.error && !repo.archived).length,
    libraries: data.libraries.length,
    multiMajor: summaries.filter((summary) => summary.majors.length > 1).length,
    reposBehindMajor: new Set(summaries.flatMap((summary) => summary.reposBehindMajor)).size,
    drifted: data.templates.filter((result) => result.status === 'drifted').length,
    missing: data.templates.filter((result) => result.status === 'missing').length,
  }
}
