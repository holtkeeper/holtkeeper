import type {
  BranchAuthorRow,
  BranchCleanupReason,
  BranchesOverview,
  BranchesRepoRow,
  BranchRow,
  RepoRef,
} from '@holtkeeper/api'

import { repoKey } from './repo.ts'
import { searchEntry, searchEnum, searchList, searchText } from './search-params.ts'
import type { SortState, SortValue } from './table-sort.ts'

/** Reasons a branch is worth deleting, in the order the page lists them. */
export const branchReasons = ['merged', 'closed', 'stale'] as const satisfies BranchCleanupReason[]

/** Words for each reason. */
export const reasonLabel: Record<BranchCleanupReason, string> = {
  merged: 'Merged',
  closed: 'Closed MR',
  stale: 'Stale',
}

/** Status tone of each reason. */
export const reasonTone = {
  merged: 'success',
  closed: 'default',
  stale: 'warning',
} as const satisfies Record<BranchCleanupReason, string>

/** Minimum ages in days the Age filter offers. */
export const branchAges = ['30', '90', '365'] as const

/** One row of Quality › Branches: a branch worth deleting in one repository. */
export interface BranchListRow extends BranchRow {
  /** `forge:path` of the repository and the branch name. */
  key: string
  repo: RepoRef
  repoKey: string
  groups: string[]
}

/** One row per listed branch of every repository on the overview, in the order the API gives. */
export function branchListRows(overview: BranchesOverview): BranchListRow[] {
  return overview.repos.flatMap((entry) => {
    const key = repoKey(entry.repo)
    return entry.branches.map((branch) => ({
      ...branch,
      key: `${key}#${branch.name}`,
      repo: entry.repo,
      repoKey: key,
      groups: entry.groups,
    }))
  })
}

/** Columns of the Branches table a person can sort by. */
export type BranchesSortKey = 'branch' | 'reason' | 'author' | 'age' | 'mr'

const sortKeys: readonly BranchesSortKey[] = ['branch', 'reason', 'author', 'age', 'mr']

const sortValues: Record<BranchesSortKey, (row: BranchListRow) => SortValue> = {
  branch: (row) => `${row.name} ${row.repo.path}`,
  reason: (row) => branchReasons.indexOf(row.reason),
  author: (row) => row.author,
  age: (row) => row.ageDays,
  mr: (row) => row.mergeRequest?.iid,
}

/** What a column sorts a row by. */
export const branchSortValue = (row: BranchListRow, key: BranchesSortKey): SortValue =>
  sortValues[key](row)

/** Panels of the side sheet: the selection, the per-author breakdown and the change since the previous run. */
export const branchPanels = ['selection', 'authors', 'changes'] as const

/** One panel of the Branches sheet. */
export type BranchPanel = (typeof branchPanels)[number]

/**
 * Search parameters of Quality › Branches: `repo` (`forge:path`) narrows to one repository; `q`,
 * `reason`, `author` and `age` (minimum days) filter the rows; `sort`/`dir` order them; `panel`
 * opens the side sheet on that panel.
 */
export interface BranchesSearch {
  repo?: string
  q?: string
  reason?: BranchCleanupReason
  author?: string[]
  age?: (typeof branchAges)[number]
  sort?: BranchesSortKey
  dir?: 'asc' | 'desc'
  panel?: BranchPanel
}

/** `BranchesSearch` from raw search values; unknown and empty values are dropped. */
export function parseBranchesSearch(search: Record<string, unknown>): BranchesSearch {
  const sort = searchEnum(search.sort, sortKeys)
  return {
    ...searchEntry('repo', searchText(search.repo)),
    ...searchEntry('q', searchText(search.q)),
    ...searchEntry('reason', searchEnum(search.reason, branchReasons)),
    ...searchEntry('author', searchList(search.author)),
    ...searchEntry('age', searchEnum(search.age, branchAges)),
    ...(sort ? { sort, dir: search.dir === 'desc' ? ('desc' as const) : ('asc' as const) } : {}),
    ...searchEntry('panel', searchEnum(search.panel, branchPanels)),
  }
}

/** The table sort a `BranchesSearch` names; `null` keeps the oldest branches first. */
export const branchesSort = (search: BranchesSearch): SortState<BranchesSortKey> =>
  search.sort ? { key: search.sort, direction: search.dir ?? 'asc' } : null

/** Rows oldest first, the order before anyone sorts. */
export const oldestFirst = (rows: readonly BranchListRow[]): BranchListRow[] =>
  rows.toSorted((a, b) => b.ageDays - a.ageDays || a.key.localeCompare(b.key))

/** Rows matching every filter of `search` except the reason, so reason counts stay meaningful. */
export function filterBranchesExceptReason(
  rows: readonly BranchListRow[],
  search: BranchesSearch,
): BranchListRow[] {
  const q = search.q?.trim().toLowerCase()
  const minAge = search.age ? Number(search.age) : 0
  return rows.filter(
    (row) =>
      (!search.repo || row.repoKey === search.repo) &&
      (!q ||
        row.name.toLowerCase().includes(q) ||
        row.repo.path.toLowerCase().includes(q) ||
        (row.author?.toLowerCase().includes(q) ?? false)) &&
      (!search.author?.length || search.author.includes(row.author ?? 'unknown')) &&
      row.ageDays >= minAge,
  )
}

/** Rows per reason, and all of them, for the reason switch. */
export function reasonCounts(
  rows: readonly BranchListRow[],
): Record<BranchCleanupReason | 'all', number> {
  return {
    all: rows.length,
    merged: rows.filter((row) => row.reason === 'merged').length,
    closed: rows.filter((row) => row.reason === 'closed').length,
    stale: rows.filter((row) => row.reason === 'stale').length,
  }
}

/** Repositories `search.repo` keeps. */
export const filterBranchRepos = (
  repos: readonly BranchesRepoRow[],
  search: BranchesSearch,
): BranchesRepoRow[] =>
  search.repo ? repos.filter((entry) => repoKey(entry.repo) === search.repo) : [...repos]

/** Strip figures over a set of repositories, from their stored counts rather than the listed rows. */
export interface BranchKpis {
  repos: number
  /** Repositories with at least one branch to clean up. */
  withCleanup: number
  cleanup: number
  merged: number
  closed: number
  stale: number
  /** Branches besides the default branch, and of them those kept for an open merge request. */
  total: number
  open: number
  oldestDays?: number
  /** Distinct stale thresholds of the repositories, smallest first. */
  staleDays: number[]
  /** Summed change of `cleanup` against each repository's previous run; absent when none has one. */
  delta?: number
  /** Repositories with a previous run. */
  compared: number
  /** Branches worth deleting that are not listed. */
  more: number
}

/** `BranchKpis` over `repos`. */
export function branchKpis(repos: readonly BranchesRepoRow[]): BranchKpis {
  const sum = (pick: (entry: BranchesRepoRow) => number) =>
    repos.reduce((total, entry) => total + pick(entry), 0)
  const compared = repos.filter((entry) => entry.delta)
  const oldest = repos.flatMap((entry) =>
    entry.oldestDays === undefined ? [] : [entry.oldestDays],
  )
  return {
    repos: repos.length,
    withCleanup: repos.filter((entry) => entry.cleanup > 0).length,
    cleanup: sum((entry) => entry.cleanup),
    merged: sum((entry) => entry.merged),
    closed: sum((entry) => entry.closed),
    stale: sum((entry) => entry.stale),
    total: sum((entry) => entry.total),
    open: sum((entry) => entry.open),
    ...(oldest.length ? { oldestDays: Math.max(...oldest) } : {}),
    staleDays: [
      ...new Set(repos.map((entry) => entry.staleDays).filter((days) => days > 0)),
    ].toSorted((a, b) => a - b),
    ...(compared.length
      ? { delta: compared.reduce((total, entry) => total + (entry.delta?.cleanup ?? 0), 0) }
      : {}),
    compared: compared.length,
    more: sum((entry) => entry.more),
  }
}

/** Branches worth deleting per author across `repos`, most first; the oldest age is the maximum. */
export function authorTotals(repos: readonly BranchesRepoRow[]): BranchAuthorRow[] {
  const byAuthor = new Map<string, BranchAuthorRow>()
  for (const entry of repos)
    for (const row of entry.authors) {
      const seen = byAuthor.get(row.author)
      byAuthor.set(
        row.author,
        seen
          ? {
              author: row.author,
              cleanup: seen.cleanup + row.cleanup,
              merged: seen.merged + row.merged,
              closed: seen.closed + row.closed,
              stale: seen.stale + row.stale,
              oldestDays: Math.max(seen.oldestDays, row.oldestDays),
            }
          : { ...row },
      )
    }
  return [...byAuthor.values()].toSorted(
    (a, b) => b.cleanup - a.cleanup || a.author.localeCompare(b.author),
  )
}

/** One repository's change since its previous run, for repositories where something changed. */
export interface BranchChange {
  repo: RepoRef
  repoKey: string
  delta: NonNullable<BranchesRepoRow['delta']>
}

/** Repositories whose counts changed since their previous run, largest change of `cleanup` first. */
export function branchChanges(repos: readonly BranchesRepoRow[]): BranchChange[] {
  return repos
    .flatMap((entry) =>
      entry.delta && Object.values(entry.delta).some((value) => value !== 0)
        ? [{ repo: entry.repo, repoKey: repoKey(entry.repo), delta: entry.delta }]
        : [],
    )
    .toSorted(
      (a, b) =>
        Math.abs(b.delta.cleanup) - Math.abs(a.delta.cleanup) || a.repoKey.localeCompare(b.repoKey),
    )
}

/** Selected branches of one repository. */
export interface SelectionGroup {
  repo: RepoRef
  repoKey: string
  branches: BranchListRow[]
}

/** The selected rows grouped by repository, most branches first. */
export function selectionByRepo(
  rows: readonly BranchListRow[],
  selected: ReadonlySet<string>,
): SelectionGroup[] {
  const groups = new Map<string, SelectionGroup>()
  for (const row of rows) {
    if (!selected.has(row.key)) continue
    const group = groups.get(row.repoKey) ?? { repo: row.repo, repoKey: row.repoKey, branches: [] }
    group.branches.push(row)
    groups.set(row.repoKey, group)
  }
  return [...groups.values()].toSorted(
    (a, b) => b.branches.length - a.branches.length || a.repoKey.localeCompare(b.repoKey),
  )
}

/** Plain text of a selection, one `path branch` line per branch, for the clipboard. */
export const selectionText = (groups: readonly SelectionGroup[]): string =>
  groups
    .flatMap((group) => group.branches.map((branch) => `${group.repo.path} ${branch.name}`))
    .join('\n')

/** A count change with an explicit sign: `+3`, `−2`, `±0`. */
export const signed = (value: number): string =>
  value === 0 ? '±0' : value > 0 ? `+${value}` : `−${Math.abs(value)}`
