import type {
  DependencyChangeKind,
  DependencyDiff,
  DependencyRoot,
  DependencySide,
  ReleaseCompareRefs,
  ReleaseCompareVersion,
} from '@holtkeeper/api'

import { searchEntry, searchText } from '../../lib/search-params.ts'
import type { StatusTone } from '../../ui/colors.ts'

/** The two ends of a comparison as the URL names them: version tags or a branch. */
export interface CompareRange {
  from?: string
  to?: string
}

/** Search of `/releases/compare`: the repository (`forge:path`) and the two ends; empty values are dropped. */
export const parseCompareSearch = (
  search: Record<string, unknown>,
): CompareRange & { repo?: string } => ({
  ...searchEntry('repo', searchText(search.repo)),
  ...searchEntry('from', searchText(search.from)),
  ...searchEntry('to', searchText(search.to)),
})

type Refs = Pick<ReleaseCompareRefs, 'versions' | 'branches'>

/** The flow's target branch, when the repository has one. */
export const targetBranch = (refs: Refs): string | undefined =>
  refs.branches.find((branch) => branch.role === 'target')?.name

/**
 * The range to compare: what the URL names, else `to` is the latest stable version (the latest
 * prerelease without one, the target branch without versions) and `from` the stable version
 * before `to` (any older version without one). With `to` on a branch or a ref that is no version,
 * `from` is the latest stable version. `from` stays absent when nothing is older.
 */
export function defaultRange(refs: Refs, search: CompareRange): CompareRange {
  const stable = (version: Refs['versions'][number]) => !version.prerelease
  const latest = refs.versions.find(stable) ?? refs.versions[0]
  const to = search.to ?? latest?.tag ?? targetBranch(refs)
  const index = refs.versions.findIndex((version) => version.tag === to)
  const older = index >= 0 ? refs.versions.slice(index + 1) : undefined
  const from = search.from ?? (older ? (older.find(stable) ?? older[0])?.tag : latest?.tag)
  return { ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) }
}

/** Whether two ranges name the same ends. */
export const sameRange = (a: CompareRange, b: CompareRange): boolean =>
  a.from === b.from && a.to === b.to

/** `from` and `to` exchanged; an absent end stays absent on the other side. */
export const swapRange = (range: CompareRange): CompareRange => ({
  ...(range.to !== undefined ? { from: range.to } : {}),
  ...(range.from !== undefined ? { to: range.from } : {}),
})

/**
 * Why the range reads backwards, when both ends are known versions and `from` is not older than
 * `to`, or `from` is the target branch; `undefined` otherwise.
 */
export function rangeProblem(refs: Refs, range: CompareRange): string | undefined {
  if (range.from === undefined || range.to === undefined) return undefined
  if (range.from === range.to) return 'Both ends are the same; there is nothing to compare.'
  if (range.from === targetBranch(refs))
    return 'From is the target branch, which is newer than every version. Swap the ends.'
  const from = refs.versions.findIndex((version) => version.tag === range.from)
  const to = refs.versions.findIndex((version) => version.tag === range.to)
  if (from >= 0 && to >= 0 && from < to) return 'From is newer than To. Swap the ends.'
  return undefined
}

/** Tag tone of a dependency change. */
export const changeTones: Record<DependencyChangeKind, StatusTone> = {
  added: 'success',
  updated: 'accent',
  removed: 'danger',
}

/** A direct dependency's side as shown: the resolved version, else the declared range, else empty. */
export const sideText = (side: DependencySide | undefined): string =>
  side?.version ?? side?.range ?? ''

/** The declared range of a side when it says more than the version shown, else `undefined`. */
export const sideRange = (side: DependencySide | undefined): string | undefined =>
  side?.range && side.version && side.range !== side.version ? side.range : undefined

/** Heading of a dependency root: its directory (`.` for the repository root). */
export const rootLabel = (root: Pick<DependencyRoot, 'path'>): string => root.path || '.'

/** Ecosystem, manager and lockfile of a root, e.g. `npm · pnpm · pnpm-lock.yaml`. */
export const rootFacts = (root: DependencyRoot): string =>
  [root.ecosystem, root.manager !== root.ecosystem ? root.manager : undefined, root.lockfile]
    .filter(Boolean)
    .join(' · ')

const counted = (parts: readonly [number, string][]) =>
  parts
    .filter(([count]) => count > 0)
    .map(([count, word]) => `${count} ${word}`)
    .join(', ')

/** Direct changes of a root in words, e.g. `2 added, 1 updated`; empty when none. */
export const directCounts = (counts: DependencyRoot['counts']): string =>
  counted([
    [counts.added, 'added'],
    [counts.updated, 'updated'],
    [counts.removed, 'removed'],
  ])

/** Transitive changes of a root in words, e.g. `14 updated, 3 removed`; empty when none. */
export const transitiveCounts = (counts: DependencyRoot['counts']): string =>
  counted([
    [counts.transitiveAdded, 'added'],
    [counts.transitiveUpdated, 'updated'],
    [counts.transitiveRemoved, 'removed'],
  ])

/** Every direct and transitive change across the roots of a diff. */
export const dependencyChangeCount = (diff: DependencyDiff): number =>
  diff.roots.reduce(
    (sum, { counts }) =>
      sum +
      counts.added +
      counts.updated +
      counts.removed +
      counts.transitiveAdded +
      counts.transitiveUpdated +
      counts.transitiveRemoved,
    0,
  )

/**
 * Whether the workspace column says anything: direct changes span several workspaces, or an npm
 * change sits outside the root workspace.
 */
export const hasWorkspaces = (root: DependencyRoot): boolean =>
  new Set(root.direct.map((change) => change.workspace)).size > 1 ||
  (root.ecosystem === 'npm' && root.direct.some((change) => change.workspace !== '.'))

/** A version as the range selects name it: the tag, then the environments that run it. */
export const versionText = (version: Pick<ReleaseCompareVersion, 'tag' | 'environments'>): string =>
  version.environments?.length ? `${version.tag} (${version.environments.join(', ')})` : version.tag
