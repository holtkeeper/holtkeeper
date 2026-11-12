import type {
  PublicApiFacetCount,
  PublicApiFacets,
  PublicApiMatch,
  PublicApiPackageRemoval,
  PublicApiPackageSummary,
  PublicApiSymbol,
  PublicApiSymbolChange,
  PublicApiSymbolHit,
  PublicApiVersion,
  RepoRef,
} from '@holtkeeper/api'
import {
  type ApiPackage,
  type ApiSurfaceData,
  type ApiSymbol,
  type ApiSymbolKind,
  type PackageDiff,
  apiSurfaceDataSchema,
  apiTotals,
  diffPackage,
  importPath,
} from '@holtkeeper/api-surface'
import type { AnalysisStore } from '@holtkeeper/store'

import type { FleetCache } from '../fleet-cache.ts'

const kind = 'api-surface'
const pageSize = 20
const headPageSize = 500
const readConcurrency = 4
/** Default branch runs that must lack a package before it counts as removed, so one bad run does not. */
const missingRuns = 2

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
  kinds: ApiSymbolKind[]
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
        kinds: [
          ...new Set(pkg.entries.flatMap((entry) => entry.symbols.map((symbol) => symbol.kind))),
        ],
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
  /** Set when the repository no longer has the package. */
  removed?: PublicApiPackageRemoval
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

const matchRank: Record<PublicApiMatch, number> = { exact: 4, prefix: 3, part: 2, doc: 1 }

function matchOf(name: string, needle: string, doc?: string): PublicApiMatch | undefined {
  const lower = name.toLowerCase()
  if (lower === needle) return 'exact'
  if (lower.startsWith(needle)) return 'prefix'
  if (lower.includes(needle)) return 'part'
  return doc?.toLowerCase().includes(needle) ? 'doc' : undefined
}

const facetOf = (values: Iterable<string>): PublicApiFacetCount[] => {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts]
    .map(([value, count]) => ({ value, count }))
    .toSorted((a, b) => b.count - a.count || a.value.localeCompare(b.value))
}

/** Filters of `ApiCatalog.packageList`; facets count the packages before `repo` and `kind` apply. */
export interface PackageListQuery {
  /** Substring of the name, description or repository. */
  q?: string
  /** `forge:path`. */
  repo?: string
  /** Only packages exporting a symbol of this kind. */
  kind?: ApiSymbolKind
}

/** Filters of `ApiCatalog.search`. */
export interface SearchFilters {
  package?: string
  kind?: ApiSymbolKind
  /** `forge:path`. */
  repo?: string
  subpath?: string
  match?: PublicApiMatch
  /** Hits returned; default 20. */
  limit?: number
  /** Also count facets over every match before the filters above apply. */
  facets?: boolean
}

/** What `ApiCatalog.symbol` looks up. */
export interface SymbolQuery {
  package: string
  name: string
  /** Entry point; the main one (`.`) or else the first exporting the name when absent. */
  subpath?: string
  version?: string
  /** `forge:path`. */
  repo?: string
  /** Recorded versions compared for the history, newest first. */
  limit: number
}

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

  /** The non-empty default branch runs since the last record of `name` in `repo`, when there are enough. */
  const missingHeads = (all: IndexedRecord[], name: string, repo: string) => {
    const own = all.filter((record) => repoKey(record.repo) === repo)
    const last = own.findIndex((record) => record.packages.some((p) => p.name === name))
    if (last < 0) return undefined
    // An empty snapshot means the extractor read nothing, not that every package left.
    const heads = own.slice(0, last).filter((record) => !record.ref && record.packages.length)
    return heads.length < missingRuns ? undefined : { heads, last: own[last] }
  }

  /** How `name` left `repo`, if it did. */
  const removalOf = (
    all: IndexedRecord[],
    name: string,
    repo: string,
  ): PublicApiPackageRemoval | undefined => {
    const missing = missingHeads(all, name, repo)
    if (!missing) return undefined
    const dir = missing.last?.packages.find((p) => p.name === name)?.dir
    const renamedTo = missing.heads[0]?.packages.find(
      (p) => p.dir === dir && !missing.last?.packages.some((old) => old.name === p.name),
    )?.name
    const movedTo = reposOf(all, name).filter(
      (other) => repoKey(other) !== repo && !missingHeads(all, name, repoKey(other)),
    )
    return {
      at: missing.heads.at(-1)?.createdAt ?? '',
      ...(movedTo.length ? { movedTo } : {}),
      ...(renamedTo ? { renamedTo } : {}),
    }
  }

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
    const repo = query.repo
      ? repos.find((r) => repoKey(r) === query.repo)
      : (repos.find((r) => !missingHeads(all, name, repoKey(r))) ?? repos[0])
    if (!repo) return undefined
    const removed = removalOf(all, name, repoKey(repo))
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
      ...(removed ? { removed } : {}),
    }
  }

  const newestPairs = (all: IndexedRecord[]) => {
    const pairs = new Map<string, { record: IndexedRecord; pkg: IndexedPackage }>()
    for (const record of all)
      for (const pkg of record.packages) {
        const key = `${repoKey(record.repo)}\u0000${pkg.name}`
        if (!pairs.has(key)) pairs.set(key, { record, pkg })
      }
    return [...pairs.values()]
  }

  const summaries = (all: IndexedRecord[], query?: string) => {
    const needle = query?.toLowerCase()
    const result: { summary: PublicApiPackageSummary; kinds: ApiSymbolKind[] }[] = []
    for (const { record, pkg } of newestPairs(all)) {
      const repo = repoKey(record.repo)
      const match = needle
        ? (matchOf(pkg.name, needle, pkg.description) ??
          (repo.toLowerCase().includes(needle) ? 'doc' : undefined))
        : undefined
      if (needle && !match) continue
      const { kinds, ...facts } = pkg
      const removed = removalOf(all, pkg.name, repo)
      result.push({
        kinds,
        summary: {
          ...facts,
          repo: record.repo,
          ...(record.ref ? { ref: record.ref } : {}),
          analysisId: record.id,
          analyzedAt: record.createdAt,
          versions: versionsOf(all, pkg.name, repo).length,
          ...(removed ? { removed } : {}),
          ...(match ? { match } : {}),
        },
      })
    }
    return result.toSorted(
      (a, b) =>
        a.summary.name.localeCompare(b.summary.name) ||
        repoKey(a.summary.repo).localeCompare(repoKey(b.summary.repo)),
    )
  }

  const symbolVersions = async (
    all: IndexedRecord[],
    query: { package: string; name: string; subpath: string; repo: string; limit: number },
  ) => {
    const versions = versionsOf(all, query.package, query.repo)
    const compared = versions.slice(0, query.limit)
    const symbols: (ApiSymbol | undefined)[] = []
    for (let start = 0; start < compared.length; start += readConcurrency) {
      // oxlint-disable-next-line no-await-in-loop -- bounded parallel reads
      const batch = await Promise.all(
        compared.slice(start, start + readConcurrency).map(async (version) =>
          (await data(version.record.id))?.packages
            .find((pkg) => pkg.name === query.package)
            ?.entries.find((entry) => entry.subpath === query.subpath)
            ?.symbols.find((symbol) => symbol.name === query.name),
        ),
      )
      symbols.push(...batch)
    }
    return { compared, symbols, capped: versions.length > compared.length }
  }

  return {
    /** Rereads every record now, e.g. after a backfill. */
    rescan: () => refresh(true),
    /** When every record was last read. */
    indexedAt: () => (scannedAt ? new Date(scannedAt).toISOString() : undefined),

    /**
     * Ids of the records readable repositories have in the catalog and those repositories as
     * `forge:path`: a cache key that changes whenever an answer read through `filter` may change.
     */
    async fingerprint(filter: RepoFilter): Promise<{ analysisIds: string[]; repos: string[] }> {
      const all = await visible(filter)
      return {
        analysisIds: all.map((record) => record.id),
        repos: [...new Set(all.map((record) => repoKey(record.repo)))],
      }
    },

    /**
     * The newest version of every package in readable repositories, sorted by name; packages their
     * repository dropped stay listed with `removed`. With `query`, only packages whose name,
     * description or repository contains it, each with its `match`.
     */
    async packages(filter: RepoFilter, query?: string): Promise<PublicApiPackageSummary[]> {
      return summaries(await visible(filter), query).map((item) => item.summary)
    },

    /** What `packages` lists for `query.q`, narrowed by `repo` and `kind`, with facets counted before. */
    async packageList(
      filter: RepoFilter,
      query: PackageListQuery = {},
    ): Promise<{ packages: PublicApiPackageSummary[]; facets: PublicApiFacets }> {
      const items = summaries(await visible(filter), query.q)
      return {
        packages: items
          .filter(
            (item) =>
              (!query.repo || repoKey(item.summary.repo) === query.repo) &&
              (!query.kind || item.kinds.includes(query.kind)),
          )
          .map((item) => item.summary),
        facets: {
          kinds: facetOf(items.flatMap((item) => item.kinds)),
          packages: facetOf(items.map((item) => item.summary.name)),
          repos: facetOf(items.map((item) => repoKey(item.summary.repo))),
        },
      }
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
     * Exported names matching `query` in the newest record of each readable repository and
     * package (packages their repository dropped included, marked `removed`): exact names first,
     * then prefixes, substrings of names, and matches in doc comments.
     */
    async search(
      filter: RepoFilter,
      query: string,
      filters: SearchFilters = {},
    ): Promise<{ hits: PublicApiSymbolHit[]; more: number; facets?: PublicApiFacets }> {
      const needle = query.trim().toLowerCase()
      const limit = filters.limit ?? 20
      const wide = filters.facets === true
      const keep = (hit: PublicApiSymbolHit) =>
        (!filters.package || hit.package === filters.package) &&
        (!filters.kind || hit.symbol.kind === filters.kind) &&
        (!filters.repo || repoKey(hit.repo) === filters.repo) &&
        (!filters.subpath || hit.subpath === filters.subpath) &&
        (!filters.match || hit.match === filters.match)
      const found: PublicApiSymbolHit[] = []
      const all = needle ? await visible(filter) : []
      const byRecord = new Map<string, { record: IndexedRecord; names: Set<string> }>()
      for (const { record, pkg } of newestPairs(all)) {
        if (!wide && filters.package && pkg.name !== filters.package) continue
        if (!wide && filters.repo && repoKey(record.repo) !== filters.repo) continue
        const entry = byRecord.get(record.id) ?? { record, names: new Set<string>() }
        entry.names.add(pkg.name)
        byRecord.set(record.id, entry)
      }
      for (const { record, names } of byRecord.values()) {
        // oxlint-disable-next-line no-await-in-loop -- records come from a small cache
        const parsed = await data(record.id)
        for (const pkg of parsed?.packages ?? []) {
          if (!names.has(pkg.name)) continue
          const removed = removalOf(all, pkg.name, repoKey(record.repo)) !== undefined
          for (const entry of pkg.entries)
            for (const symbol of entry.symbols) {
              if (!wide && filters.kind && symbol.kind !== filters.kind) continue
              const match = matchOf(symbol.name, needle, symbol.doc)
              if (!match) continue
              found.push({
                package: pkg.name,
                ...(pkg.version ? { version: pkg.version } : {}),
                repo: record.repo,
                subpath: entry.subpath,
                importPath: importPath(pkg.name, entry.subpath),
                ...(record.ref ? { ref: record.ref } : {}),
                match,
                deprecated: symbol.deprecated !== undefined,
                removed,
                symbol,
              })
            }
        }
      }
      const hits = found
        .filter(keep)
        .toSorted(
          (a, b) =>
            matchRank[b.match] - matchRank[a.match] ||
            Number(a.removed) - Number(b.removed) ||
            a.symbol.name.length - b.symbol.name.length ||
            a.importPath.localeCompare(b.importPath),
        )
      return {
        hits: hits.slice(0, limit),
        more: Math.max(0, hits.length - limit),
        ...(wide
          ? {
              facets: {
                kinds: facetOf(found.map((hit) => hit.symbol.kind)),
                packages: facetOf(found.map((hit) => hit.package)),
                repos: facetOf(found.map((hit) => repoKey(hit.repo))),
                subpaths: facetOf(found.map((hit) => hit.subpath)),
                matches: facetOf(found.map((hit) => hit.match)),
              },
            }
          : {}),
      }
    },

    /**
     * One exported symbol of a resolved package version and the recorded versions where it was
     * added, changed, deprecated or dropped, comparing at most `query.limit` versions of its
     * repository, newest first; `undefined` when the version or the symbol is not on record.
     */
    async symbol(filter: RepoFilter, query: SymbolQuery): Promise<PublicApiSymbol | undefined> {
      const found = await resolve(filter, query.package, {
        ...(query.version ? { version: query.version } : {}),
        ...(query.repo ? { repo: query.repo } : {}),
      })
      if (!found) return undefined
      const exporting = found.package.entries.filter((entry) =>
        entry.symbols.some((symbol) => symbol.name === query.name),
      )
      const entry = query.subpath
        ? exporting.find((item) => item.subpath === query.subpath)
        : (exporting.find((item) => item.subpath === '.') ?? exporting[0])
      const symbol = entry?.symbols.find((item) => item.name === query.name)
      if (!entry || !symbol) return undefined
      const { compared, symbols, capped } = await symbolVersions(await visible(filter), {
        package: query.package,
        name: query.name,
        subpath: entry.subpath,
        repo: repoKey(found.record.repo),
        limit: query.limit,
      })
      const changes: PublicApiSymbolChange[] = []
      for (const [index, version] of compared.entries()) {
        const after = symbols[index]
        const before = symbols[index + 1]
        const base = {
          version: version.version,
          ...(version.ref ? { ref: version.ref } : {}),
          analyzedAt: version.analyzedAt,
        }
        if (index === compared.length - 1) {
          if (after && !capped) changes.push({ ...base, change: 'added', after: after.signature })
        } else if (after && !before)
          changes.push({ ...base, change: 'added', after: after.signature })
        else if (!after && before)
          changes.push({ ...base, change: 'removed', before: before.signature })
        else if (after && before) {
          const deprecated = after.deprecated !== undefined && before.deprecated === undefined
          if (deprecated || after.signature !== before.signature)
            changes.push({
              ...base,
              change: deprecated ? 'deprecated' : 'changed',
              before: before.signature,
              after: after.signature,
            })
        }
      }
      return {
        package: found.package.name,
        ...(found.package.version ? { version: found.package.version } : {}),
        repo: found.record.repo,
        ...(found.record.ref ? { ref: found.record.ref } : {}),
        analysisId: found.record.id,
        analyzedAt: found.record.createdAt,
        subpath: entry.subpath,
        importPath: importPath(found.package.name, entry.subpath),
        symbol,
        alsoIn: exporting.filter((item) => item !== entry).map((item) => item.subpath),
        ...(found.removed ? { removed: found.removed } : {}),
        history: { changes, versions: compared.length, capped },
      }
    },
  }
}

export type ApiCatalog = ReturnType<typeof createApiCatalog>

/**
 * `load` through `cache`: the answer stays while the catalog records `canRead` sees stay the same,
 * per `endpoint` (which names every parameter that changes the answer).
 */
export const cachedCatalog = async <T>(
  cache: FleetCache,
  catalog: ApiCatalog,
  canRead: RepoFilter,
  endpoint: string,
  load: () => Promise<T>,
): Promise<T> => cache.read({ endpoint, ...(await catalog.fingerprint(canRead)) }, load)
