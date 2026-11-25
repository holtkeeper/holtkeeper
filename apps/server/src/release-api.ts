import type { ReleaseCompareApi, ReleaseCompareApiPackage } from '@holtkeeper/api'
import {
  type ApiPackage,
  type ApiSurfaceData,
  type PackageDiff,
  apiSurfaceDataSchema,
  breaksCallers,
  diffPackage,
  renderDiff,
  withoutFolderTwins,
} from '@holtkeeper/api-surface'
import type { RepoRef } from '@holtkeeper/forge'
import type { AnalysisHead, AnalysisStore } from '@holtkeeper/store'
import { narrowImpact, renderImpact } from '@holtkeeper/usages'

import type { RepoFilter } from './api-surface/catalog.ts'
import { type UsageIndex, impactOfChanges } from './api-surface/usages.ts'

const KIND = 'api-surface'
const HEADS = 500

/** One end of a compared range: the tag or branch it names and the commit when known. */
export interface ApiRangeEnd {
  ref: string
  sha?: string
  /** The end is the target branch: its newest default-branch record answers. */
  head?: boolean
}

/** Inputs of `publicApiBetween`. */
export interface PublicApiBetweenInput {
  analyses: Pick<AnalysisStore, 'heads' | 'get'>
  repo: RepoRef
  /** Absent when the range starts at the first commit: nothing can be compared then. */
  from?: ApiRangeEnd
  to: ApiRangeEnd
  /** With it, each changed package carries the uses in other repositories its changes touch. */
  impact?: { usages: UsageIndex; filter: RepoFilter }
}

const repoKey = (repo: RepoRef) => `${repo.forge}:${repo.path}`

const parse = (data: unknown): ApiSurfaceData | undefined => {
  const parsed = apiSurfaceDataSchema.safeParse(data)
  if (!parsed.success || !parsed.data.packages.length) return undefined
  return {
    ...parsed.data,
    packages: parsed.data.packages.map((pkg) => ({
      ...pkg,
      entries: withoutFolderTwins(pkg.entries),
    })),
  }
}

/**
 * Heads that describe `end`, best first: records of its tag, then of its commit (package-tag
 * releases are recorded under the commit), then default-branch runs at that commit; for a target
 * branch end the default-branch runs, newest first.
 */
export function recordsAt(heads: readonly AnalysisHead[], end: ApiRangeEnd): AnalysisHead[] {
  if (end.head) return heads.filter((head) => !head.ref)
  const { sha } = end
  return [
    ...heads.filter((head) => head.ref === end.ref),
    ...(sha ? heads.filter((head) => head.ref === sha) : []),
    ...(sha ? heads.filter((head) => !head.ref && head.sha === sha) : []),
  ]
}

const firstData = async (
  analyses: PublicApiBetweenInput['analyses'],
  candidates: readonly AnalysisHead[],
) => {
  for (const head of candidates) {
    // oxlint-disable-next-line no-await-in-loop -- the first usable record wins
    const data = parse((await analyses.get(head.id))?.data)
    if (data) return data
  }
  return undefined
}

const changed = (
  diff: PackageDiff,
  before: ApiPackage | undefined,
  after: ApiPackage | undefined,
) => !before || !after || diff.changes.length > 0

const breaks = (diff: PackageDiff) => Number(breaksCallers(diff))

/**
 * The changed packages of two `api-surface` snapshots, by package name, sorted with the ones that
 * break callers (removed packages, removed exports, lost members) first, then by name.
 */
export function diffSnapshots(
  before: readonly ApiPackage[],
  after: readonly ApiPackage[],
): { name: string; before?: ApiPackage; after?: ApiPackage; diff: PackageDiff }[] {
  const names = [...new Set([...before.map((pkg) => pkg.name), ...after.map((pkg) => pkg.name)])]
  return names
    .flatMap((name) => {
      const old = before.find((pkg) => pkg.name === name)
      const next = after.find((pkg) => pkg.name === name)
      const diff = diffPackage(old, next)
      return changed(diff, old, next)
        ? [{ name, ...(old ? { before: old } : {}), ...(next ? { after: next } : {}), diff }]
        : []
    })
    .toSorted((a, b) => breaks(b.diff) - breaks(a.diff) || a.name.localeCompare(b.name))
}

const impactOf = async (
  input: NonNullable<PublicApiBetweenInput['impact']>,
  repo: RepoRef,
  item: { name: string; before?: ApiPackage; after?: ApiPackage; diff: PackageDiff },
  head: boolean,
): Promise<ReleaseCompareApiPackage['impact']> => {
  if (!item.diff.changes.some((change) => change.change !== 'added')) return undefined
  const own = repoKey(repo)
  const found = await impactOfChanges(input.usages, input.filter, item.before?.name ?? item.name, {
    before: item.before,
    changes: item.diff.changes,
    target: head ? undefined : item.after?.version,
  })
  const { impact } = narrowImpact(found, (origin) => origin !== own)
  if (!impact.affected.length) return undefined
  const uses = (level: string) =>
    impact.items
      .filter((entry) => entry.level === level)
      .reduce((sum, entry) => sum + entry.count, 0)
  return {
    repos: impact.affected.length,
    breaking: uses('breaking'),
    check: uses('check'),
    ...(impact.affected.length ? { markdown: renderImpact(impact) } : {}),
  }
}

/**
 * How the public API of `repo`'s own packages changed between two ends of a range, from stored
 * `api-surface` records (see `ReleaseCompareApi`, without `backfill`). Records whose extractor
 * read nothing count as missing; when no record of the repository has data, it is not `recorded`.
 * Matches whole snapshots by the end's tag or commit rather than going through the API catalog,
 * whose version list keeps one record per package version and so loses tags at which a package
 * did not change. Reads only `repo`'s records; the caller checks it may.
 */
export async function publicApiBetween(
  input: PublicApiBetweenInput,
): Promise<Omit<ReleaseCompareApi, 'backfill'>> {
  const { analyses, repo } = input
  const heads = await analyses.heads({ repo, kind: KIND, limit: HEADS })
  if (!heads.length) return { packages: [], missing: [], recorded: false }
  const [before, after] = await Promise.all([
    input.from ? firstData(analyses, recordsAt(heads, input.from)) : undefined,
    firstData(analyses, recordsAt(heads, input.to)),
  ])
  if (!before || !after) {
    const named = after ?? before ?? (await firstData(analyses, heads))
    if (!named) return { packages: [], missing: [], recorded: false }
    const side = !before && !after ? 'both' : before ? 'to' : 'from'
    return {
      packages: [],
      missing: named.packages.map((pkg) => ({ name: pkg.name, side })),
      recorded: true,
    }
  }
  const head = input.to.head === true
  const packages = await Promise.all(
    diffSnapshots(before.packages, after.packages).map(
      async (item): Promise<ReleaseCompareApiPackage> => {
        const impact = input.impact ? await impactOf(input.impact, repo, item, head) : undefined
        const ecosystem = item.after?.ecosystem ?? item.before?.ecosystem
        const from = item.before ? (item.before.version ?? input.from?.ref) : undefined
        const to = item.after ? (item.after.version ?? input.to.ref) : undefined
        return {
          name: item.name,
          ...(ecosystem ? { ecosystem } : {}),
          ...(from ? { from } : {}),
          ...(to ? { to } : {}),
          diff: item.diff,
          markdown: renderDiff(item.diff),
          ...(impact ? { impact } : {}),
        }
      },
    ),
  )
  return { packages, missing: [], recorded: true }
}

/**
 * The tags to snapshot so the comparison can run: the ends of the range that lack a record and
 * name a tag or commit (`missing` sides, or both ends when nothing is recorded). A target branch
 * end is left out: its scheduled default-branch run records it.
 */
export function backfillRefs(
  ends: Pick<PublicApiBetweenInput, 'from' | 'to'>,
  api: Pick<ReleaseCompareApi, 'missing' | 'recorded'>,
): string[] {
  const sides = new Set(api.missing.map((item) => item.side))
  const lacks = (side: 'from' | 'to') => !api.recorded || sides.has(side) || sides.has('both')
  return [
    ...(ends.from && lacks('from') ? [ends.from.ref] : []),
    ...(!ends.to.head && lacks('to') ? [ends.to.ref] : []),
  ]
}
