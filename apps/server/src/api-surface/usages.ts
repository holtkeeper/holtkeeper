import type { RepoRef } from '@holtkeeper/api'
import type { ApiChange, ApiPackage } from '@holtkeeper/api-surface'
import { compareVersions } from '@holtkeeper/depgraph'
import type { AnalysisStore } from '@holtkeeper/store'
import { newestRecords } from '@holtkeeper/store'
import {
  type UsageEntry,
  type UsagesData,
  upgradeImpact,
  usagesDataSchema,
} from '@holtkeeper/usages'

import type { ApiCatalog, RepoFilter } from './catalog.ts'

const kind = 'usages'
const repoKey = (repo: RepoRef) => `${repo.forge}:${repo.path}`

/** The newest `usages` record of one repository. */
export interface UsageRecord {
  id: string
  repo: RepoRef
  ref?: string
  createdAt: string
  data: UsagesData
}

/** Options of `createUsageIndex`. */
export interface UsageIndexOptions {
  analyses: AnalysisStore
  /** Records are reread at most this often. Default 2 min. */
  refreshMs?: number
  now?: () => number
}

/**
 * The newest `usages` record of every repository, for "used by" views, upgrade impact and the
 * MCP tools. Records are reread on demand at most every `refreshMs`; data of records that did not
 * change is kept rather than parsed again.
 */
export function createUsageIndex(options: UsageIndexOptions) {
  const now = options.now ?? Date.now
  const refreshMs = options.refreshMs ?? 120_000
  let latest = new Map<string, UsageRecord>()
  let loadedAt = 0
  let pending: Promise<void> | undefined

  const load = async () => {
    const known = new Map([...latest.values()].map((record) => [record.id, record]))
    const found = await newestRecords(options.analyses, kind, (record): UsageRecord | undefined => {
      const reused = known.get(record.id)
      if (reused) return reused
      const parsed = usagesDataSchema.safeParse(record.data)
      if (!parsed.success) return undefined
      return {
        id: record.id,
        repo: record.repo,
        ...(record.ref ? { ref: record.ref } : {}),
        createdAt: record.createdAt,
        data: parsed.data,
      }
    })
    const next = new Map([...found].map(([key, { value }]) => [key, value]))
    latest = next
    loadedAt = now()
  }

  const refresh = (force = false) => {
    if (pending) return pending
    if (!force && loadedAt && now() - loadedAt < refreshMs) return Promise.resolve()
    pending = load().finally(() => {
      pending = undefined
    })
    return pending
  }

  const records = async (filter: RepoFilter) => {
    await refresh()
    return [...latest.values()].filter((record) => filter(record.repo))
  }

  return {
    /** Rereads every record now. */
    rescan: () => refresh(true),
    /** When the records were last read. */
    indexedAt: () => (loadedAt ? new Date(loadedAt).toISOString() : undefined),
    records,
    /** Readable records as entries keyed by `forge:path`, sorted by it. */
    async entries(filter: RepoFilter): Promise<UsageEntry[]> {
      return (await records(filter))
        .map((record) => ({ origin: repoKey(record.repo), data: record.data }))
        .toSorted((a, b) => a.origin.localeCompare(b.origin))
    },
    /** The record of one repository, by `forge:path`. */
    async record(filter: RepoFilter, origin: string) {
      return (await records(filter)).find((record) => repoKey(record.repo) === origin)
    },
  }
}

export type UsageIndex = ReturnType<typeof createUsageIndex>

/**
 * The uses of `name` that `changes` (from `before` to version `target`) affect, over the newest
 * usage record of every readable repository; repositories already on `target` or later are left
 * out. Without `target` (a default branch) every user counts.
 */
export async function impactOfChanges(
  usages: UsageIndex,
  filter: RepoFilter,
  name: string,
  input: { before: ApiPackage | undefined; changes: ApiChange[]; target: string | undefined },
) {
  const declarations = new Map(
    (input.before?.entries ?? []).flatMap((entry) =>
      entry.symbols.map((symbol) => [symbol.name, symbol.signature] as const),
    ),
  )
  const { target } = input
  const entries = (await usages.entries(filter)).filter(({ data }) => {
    const used = data.packages.find((pkg) => pkg.name === name)
    if (!used || !target || !used.versions.length) return true
    return used.versions.some((version) => compareVersions(version, target) < 0)
  })
  return upgradeImpact({ entries, package: name, changes: input.changes, declarations })
}

/**
 * The uses an upgrade of `name` affects: the API diff between two recorded versions joined with
 * the newest usage record of every readable repository. Repositories already on `to` or later are
 * left out. `undefined` when the catalog has no two versions to compare.
 */
export async function impactOf(
  catalog: ApiCatalog,
  usages: UsageIndex,
  filter: RepoFilter,
  name: string,
  query: { from?: string; to?: string; repo?: string },
) {
  const diff = await catalog.diff(filter, name, query)
  if (!diff) return undefined
  const old = await catalog.resolve(filter, name, {
    version: diff.from.analysisId,
    repo: repoKey(diff.repo),
  })
  return {
    repo: diff.repo,
    from: diff.from,
    to: diff.to,
    impact: await impactOfChanges(usages, filter, name, {
      before: old?.package,
      changes: diff.diff.changes,
      target: diff.to.head ? undefined : diff.to.version,
    }),
  }
}
