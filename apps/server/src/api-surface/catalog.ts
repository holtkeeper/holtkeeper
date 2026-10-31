import type {
  PublicApiPackageSummary,
  PublicApiSymbolHit,
  PublicApiVersion,
  RepoRef,
} from '@holtkeeper/api'
import {
  type ApiPackage,
  type ApiSurfaceData,
  type ApiSymbolKind,
  type PackageDiff,
  apiSurfaceDataSchema,
  apiTotals,
  diffPackage,
  importPath,
} from '@holtkeeper/api-surface'
import type { AnalysisStore } from '@holtkeeper/store'

const kind = 'api-surface'
const pageSize = 20
const headPageSize = 500
const readConcurrency = 4

interface IndexedPackage {
  name: string
  version?: string
  description?: string
  private: boolean
  dir: string
  subpaths: string[]
  exports: number
  documented: number
  deprecated: number
}

/** What the catalog keeps of a record without its data. */
export interface IndexedRecord {
  id: string
  repo: RepoRef
  ref?: string
  createdAt: string
  packages: IndexedPackage[]
}

const repoKey = (repo: RepoRef) => `${repo.forge}:${repo.path}`

function indexRecord(record: {
  id: string
  repo: RepoRef
  ref?: string
  createdAt: string
  data: unknown
}): IndexedRecord | undefined {
  const parsed = apiSurfaceDataSchema.safeParse(record.data)
  if (!parsed.success) return undefined
  return {
    id: record.id,
    repo: record.repo,
    ...(record.ref ? { ref: record.ref } : {}),
    createdAt: record.createdAt,
    packages: parsed.data.packages.map((pkg) => {
      const totals = apiTotals([pkg])
      return {
        name: pkg.name,
        ...(pkg.version ? { version: pkg.version } : {}),
        ...(pkg.description ? { description: pkg.description } : {}),
        private: pkg.private,
        dir: pkg.dir,
        subpaths: pkg.entries.map((entry) => entry.subpath),
        exports: totals.symbols,
        documented: totals.documented,
        deprecated: totals.deprecated,
      }
    }),
  }
}

/** A package version the catalog resolved, with the record it comes from. */
export interface ResolvedPackage {
  record: IndexedRecord
  package: ApiPackage
  version: PublicApiVersion
  versions: PublicApiVersion[]
  /** Other repositories with a package of the same name. */
  alsoIn: RepoRef[]
}

/** Options of `createApiCatalog`. */
export interface ApiCatalogOptions {
  analyses: AnalysisStore
  /** Newest records are checked at most this often. Default 15 s. */
  refreshMs?: number
  /** Every record is reread at most this often, which picks up backfilled releases. Default 10 min. */
  rescanMs?: number
  /** Parsed records kept in memory. Default 48. */
  cacheSize?: number
  now?: () => number
}

/** Which repositories the caller may read; lists filter on it. */
export type RepoFilter = (repo: RepoRef) => boolean

/**
 * The packages, versions and symbols of every `api-surface` record, for the API routes and the
 * MCP endpoint. Records are indexed without their data; the newest are polled often, the whole
 * list is reread less often (records of past releases carry the release date, so they may land
 * anywhere in the list). Record data is read on demand and cached.
 */
export function createApiCatalog(options: ApiCatalogOptions) {
  const now = options.now ?? Date.now
  const refreshMs = options.refreshMs ?? 15_000
  const rescanMs = options.rescanMs ?? 600_000
  const cacheSize = options.cacheSize ?? 48
  let records = new Map<string, IndexedRecord>()
  let checkedAt = 0
  let scannedAt = 0
  let pending: Promise<void> | undefined
  const cache = new Map<string, ApiSurfaceData>()

  /** Indexes the records of `ids` not indexed yet, reading their data a few at a time. */
  const indexMissing = async (ids: string[], into: Map<string, IndexedRecord>) => {
    for (let start = 0; start < ids.length; start += readConcurrency) {
      // oxlint-disable-next-line no-await-in-loop -- bounded parallel reads
      const batch = await Promise.all(
        ids.slice(start, start + readConcurrency).map((id) => options.analyses.get(id)),
      )
      for (const record of batch) {
        const indexed = record && indexRecord(record)
        if (indexed) into.set(indexed.id, indexed)
      }
    }
  }

  const scan = async () => {
    const next = new Map<string, IndexedRecord>()
    const missing: string[] = []
    let before: string | undefined
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- pages depend on the previous one
      const page = await options.analyses.heads({
        kind,
        limit: headPageSize,
        ...(before ? { before } : {}),
      })
      for (const head of page) {
        const known = records.get(head.id)
        if (known) next.set(head.id, known)
        else missing.push(head.id)
      }
      if (page.length < headPageSize) break
      before = page.at(-1)?.createdAt
    }
    await indexMissing(missing, next)
    records = next
    scannedAt = now()
    checkedAt = scannedAt
  }

  const check = async () => {
    const page = await options.analyses.heads({ kind, limit: pageSize })
    const fresh = page.filter((head) => !records.has(head.id)).map((head) => head.id)
    await indexMissing(fresh, records)
    checkedAt = now()
    if (fresh.length === page.length && page.length === pageSize) await scan()
  }

  const refresh = (force = false) => {
    if (pending) return pending
    const time = now()
    const work =
      force || !scannedAt || time - scannedAt >= rescanMs
        ? scan
        : time - checkedAt >= refreshMs
          ? check
          : undefined
    if (!work) return Promise.resolve()
    pending = work().finally(() => {
      pending = undefined
    })
    return pending
  }

  const data = async (id: string): Promise<ApiSurfaceData | undefined> => {
    const cached = cache.get(id)
    if (cached) {
      cache.delete(id)
      cache.set(id, cached)
      return cached
    }
    const record = await options.analyses.get(id)
    const parsed = record ? apiSurfaceDataSchema.safeParse(record.data) : undefined
    if (!parsed?.success) return undefined
    cache.set(id, parsed.data)
    while (cache.size > cacheSize) cache.delete(cache.keys().next().value ?? '')
    return parsed.data
  }

  const visible = async (filter: RepoFilter) => {
    await refresh()
    return [...records.values()]
      .filter((record) => filter(record.repo))
      .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
  }

  /** Versions of `name` in `repo`, newest first: one per released version, plus the newest head. */
  const versionsOf = (all: IndexedRecord[], name: string, repo: string) => {
    const versions: (PublicApiVersion & { record: IndexedRecord })[] = []
    const seen = new Set<string>()
    let head = false
    for (const record of all) {
      if (repoKey(record.repo) !== repo) continue
      const pkg = record.packages.find((p) => p.name === name)
      if (!pkg) continue
      if (!record.ref) {
        if (head) continue
        head = true
      }
      const version = pkg.version ?? record.ref ?? 'head'
      const key = record.ref ? `v:${version}` : 'head'
      if (seen.has(key)) continue
      seen.add(key)
      versions.push({
        version,
        ...(record.ref ? { ref: record.ref } : {}),
        head: !record.ref,
        analysisId: record.id,
        analyzedAt: record.createdAt,
        exports: pkg.exports,
        record,
      })
    }
    return versions
  }

  const reposOf = (all: IndexedRecord[], name: string) => [
    ...new Map(
      all
        .filter((record) => record.packages.some((p) => p.name === name))
        .map((record) => [repoKey(record.repo), record.repo]),
    ).values(),
  ]

  const strip = (version: PublicApiVersion & { record: IndexedRecord }): PublicApiVersion => ({
    version: version.version,
    ...(version.ref ? { ref: version.ref } : {}),
    head: version.head,
    analysisId: version.analysisId,
    analyzedAt: version.analyzedAt,
    exports: version.exports,
  })

  const pick = (
    versions: (PublicApiVersion & { record: IndexedRecord })[],
    wanted: string | undefined,
  ) => {
    const query = wanted?.replace(/^v(?=\d)/, '')
    if (!query || query === 'latest')
      return versions.find((version) => !version.head) ?? versions[0]
    if (query === 'head') return versions.find((version) => version.head) ?? versions[0]
    const matches = (version: PublicApiVersion) =>
      version.version === query ||
      version.version === wanted ||
      version.ref === wanted ||
      version.analysisId === wanted ||
      version.ref?.endsWith(`@${query}`)
    return versions.find((version) => !version.head && matches(version)) ?? versions.find(matches)
  }

  const resolve = async (
    filter: RepoFilter,
    name: string,
    query: { version?: string; repo?: string } = {},
  ): Promise<ResolvedPackage | undefined> => {
    const all = await visible(filter)
    const repos = reposOf(all, name)
    const repo = query.repo ? repos.find((r) => repoKey(r) === query.repo) : repos[0]
    if (!repo) return undefined
    const versions = versionsOf(all, name, repoKey(repo))
    const chosen = pick(versions, query.version)
    if (!chosen) return undefined
    const found = (await data(chosen.record.id))?.packages.find((p) => p.name === name)
    if (!found) return undefined
    return {
      record: chosen.record,
      package: found,
      version: strip(chosen),
      versions: versions.map(strip),
      alsoIn: repos.filter((r) => repoKey(r) !== repoKey(repo)),
    }
  }

  return {
    /** Rereads every record now, e.g. after a backfill. */
    rescan: () => refresh(true),
    /** When every record was last read. */
    indexedAt: () => (scannedAt ? new Date(scannedAt).toISOString() : undefined),

    /** The newest version of every package in readable repositories, sorted by name. */
    async packages(filter: RepoFilter, query?: string): Promise<PublicApiPackageSummary[]> {
      const all = await visible(filter)
      const latest = new Map<string, PublicApiPackageSummary>()
      const needle = query?.toLowerCase()
      for (const record of all)
        for (const pkg of record.packages) {
          const key = `${repoKey(record.repo)}\u0000${pkg.name}`
          if (latest.has(key)) continue
          if (
            needle &&
            !pkg.name.toLowerCase().includes(needle) &&
            !pkg.description?.toLowerCase().includes(needle) &&
            !repoKey(record.repo).toLowerCase().includes(needle)
          )
            continue
          latest.set(key, {
            ...pkg,
            repo: record.repo,
            ...(record.ref ? { ref: record.ref } : {}),
            analysisId: record.id,
            analyzedAt: record.createdAt,
            versions: versionsOf(all, pkg.name, repoKey(record.repo)).length,
          })
        }
      return [...latest.values()].toSorted(
        (a, b) => a.name.localeCompare(b.name) || repoKey(a.repo).localeCompare(repoKey(b.repo)),
      )
    },

    resolve,

    /** Differences between two versions; `from` defaults to the version before `to`. */
    async diff(
      filter: RepoFilter,
      name: string,
      query: { from?: string; to?: string; repo?: string },
    ): Promise<
      { repo: RepoRef; from: PublicApiVersion; to: PublicApiVersion; diff: PackageDiff } | undefined
    > {
      const to = await resolve(filter, name, {
        ...(query.to ? { version: query.to } : {}),
        ...(query.repo ? { repo: query.repo } : {}),
      })
      if (!to) return undefined
      const repo = repoKey(to.record.repo)
      const index = to.versions.findIndex((version) => version.analysisId === to.version.analysisId)
      const fromVersion = query.from
        ? query.from
        : (to.versions.slice(index + 1).find((version) => !version.head)?.analysisId ?? undefined)
      if (!fromVersion) return undefined
      const from = await resolve(filter, name, { version: fromVersion, repo })
      if (!from) return undefined
      return {
        repo: to.record.repo,
        from: from.version,
        to: to.version,
        diff: diffPackage(from.package, to.package),
      }
    },

    /**
     * Exported names matching `query` in the newest record of each readable repository: exact
     * names first, then prefixes, substrings of names, and matches in doc comments.
     */
    async search(
      filter: RepoFilter,
      query: string,
      filters: { package?: string; kind?: ApiSymbolKind; limit?: number } = {},
    ): Promise<{ hits: PublicApiSymbolHit[]; more: number }> {
      const needle = query.trim().toLowerCase()
      const limit = filters.limit ?? 20
      if (!needle) return { hits: [], more: 0 }
      const all = await visible(filter)
      const newest = new Map<string, IndexedRecord>()
      for (const record of all)
        if (!newest.has(repoKey(record.repo))) newest.set(repoKey(record.repo), record)
      const scored: { score: number; hit: PublicApiSymbolHit }[] = []
      for (const record of newest.values()) {
        if (filters.package && !record.packages.some((p) => p.name === filters.package)) continue
        // oxlint-disable-next-line no-await-in-loop -- records come from a small cache
        const parsed = await data(record.id)
        for (const pkg of parsed?.packages ?? []) {
          if (filters.package && pkg.name !== filters.package) continue
          for (const entry of pkg.entries)
            for (const symbol of entry.symbols) {
              if (filters.kind && symbol.kind !== filters.kind) continue
              const name = symbol.name.toLowerCase()
              const score =
                name === needle
                  ? 4
                  : name.startsWith(needle)
                    ? 3
                    : name.includes(needle)
                      ? 2
                      : symbol.doc?.toLowerCase().includes(needle)
                        ? 1
                        : 0
              if (!score) continue
              scored.push({
                score,
                hit: {
                  package: pkg.name,
                  ...(pkg.version ? { version: pkg.version } : {}),
                  repo: record.repo,
                  subpath: entry.subpath,
                  importPath: importPath(pkg.name, entry.subpath),
                  symbol,
                },
              })
            }
        }
      }
      scored.sort(
        (a, b) =>
          b.score - a.score ||
          a.hit.symbol.name.length - b.hit.symbol.name.length ||
          a.hit.importPath.localeCompare(b.hit.importPath),
      )
      return {
        hits: scored.slice(0, limit).map((item) => item.hit),
        more: Math.max(0, scored.length - limit),
      }
    },
  }
}

export type ApiCatalog = ReturnType<typeof createApiCatalog>
