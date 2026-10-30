import type { RepoRef } from '@holtkeeper/forge'
import type { AnalysisRecord, AnalysisStore } from '@holtkeeper/store'

import { type DepgraphData, depgraphDataSchema } from './analyze.ts'
import { ownPackages } from './inventory.ts'
import { compareVersions } from './version.ts'

/** A package one of the analyzed repositories defines, with the version in its source. */
export interface InternalPackage {
  ecosystem: string
  name: string
  version: string
  /** The repository that defines it. */
  repo: RepoRef
  /** Workspace directory inside that repository. */
  path?: string
}

/** Packages the analyzed repositories define, by ecosystem and name. */
export interface PackageCatalog {
  find(ecosystem: string, name: string): InternalPackage | undefined
  readonly size: number
}

const catalogKey = (ecosystem: string, name: string) => `${ecosystem}\0${name}`

/**
 * The catalog of the packages `entries` define. When several repositories define the same
 * package, the highest version wins.
 */
export function packageCatalog(
  entries: Iterable<{ repo: RepoRef; data: DepgraphData }>,
): PackageCatalog {
  const packages = new Map<string, InternalPackage>()
  for (const { repo, data } of entries) {
    for (const own of ownPackages(data)) {
      const key = catalogKey(own.ecosystem, own.name)
      const known = packages.get(key)
      if (known && compareVersions(known.version, own.version) >= 0) continue
      packages.set(key, { ...own, repo })
    }
  }
  return {
    find: (ecosystem, name) => packages.get(catalogKey(ecosystem, name)),
    size: packages.size,
  }
}

export interface LatestDepgraphsOptions {
  /** Records to accept, e.g. only those the caller may see. Default: all. */
  accept?: (record: AnalysisRecord) => boolean
  /** Records read at most, newest first. Default 2000. */
  maxRecords?: number
}

/** The newest valid `depgraph` record of every repository, by `forge:path`. */
export async function latestDepgraphs(
  analyses: Pick<AnalysisStore, 'list'>,
  options: LatestDepgraphsOptions = {},
): Promise<Map<string, { record: AnalysisRecord; data: DepgraphData }>> {
  const { accept = () => true, maxRecords = 2000 } = options
  const pageSize = 100
  const latest = new Map<string, { record: AnalysisRecord; data: DepgraphData }>()
  let before: string | undefined
  for (let seen = 0; seen < maxRecords; seen += pageSize) {
    const page = await analyses.list({
      kind: 'depgraph',
      limit: pageSize,
      ...(before && { before }),
    })
    for (const record of page) {
      const key = `${record.repo.forge}:${record.repo.path}`
      if (latest.has(key) || !accept(record)) continue
      const parsed = depgraphDataSchema.safeParse(record.data)
      if (parsed.success) latest.set(key, { record, data: parsed.data })
    }
    if (page.length < pageSize) break
    before = page.at(-1)?.createdAt
  }
  return latest
}

/** The catalog of every repository's newest `depgraph` record in `analyses`. */
export async function loadPackageCatalog(
  analyses: Pick<AnalysisStore, 'list'>,
  options: LatestDepgraphsOptions = {},
): Promise<PackageCatalog> {
  const latest = await latestDepgraphs(analyses, options)
  return packageCatalog(
    [...latest.values()].map(({ record, data }) => ({ repo: record.repo, data })),
  )
}
