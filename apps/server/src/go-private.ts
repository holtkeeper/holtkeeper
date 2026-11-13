import type { HoltkeeperConfig } from '@holtkeeper/core'
import type { RepoRef } from '@holtkeeper/forge'
import type { AnalysisStore, ConfigStore } from '@holtkeeper/store'

/** A panel forge as `goPrivate` reads it. */
export interface GoPrivateForge {
  id: string
  kind: string
  url: string
  /** `false` when the forge's "Packages for jobs" is off: the proxy adds no token for it. */
  packages?: boolean | undefined
}

/** A config group as `goPrivate` reads it. */
export interface GoPrivateGroup {
  forge: string
  include: readonly string[]
}

const glob = /[*?[\]{}!]/

/**
 * The `GOPRIVATE` patterns for the GitLab forges the egress proxy adds a token for: `host/<top>`
 * for every top-level group the forge's config groups include, or the whole host (with the
 * instance's sub-path) when a group's pattern starts with a wildcard or the forge has no group.
 * Sorted and without duplicates; `undefined` when no forge qualifies.
 */
export function goPrivate(
  forges: readonly GoPrivateForge[],
  groups: readonly GoPrivateGroup[],
): string | undefined {
  const patterns = new Set<string>()
  for (const forge of forges) {
    if (forge.kind !== 'gitlab' || forge.packages === false) continue
    let base: string
    try {
      const url = new URL(forge.url)
      base = `${url.hostname}${url.pathname.replace(/\/+$/, '')}`
    } catch {
      continue
    }
    const includes = groups.filter((group) => group.forge === forge.id).flatMap((g) => g.include)
    const tops = includes.map((pattern) => pattern.replace(/^\/+/, '').split('/')[0] ?? '')
    if (!tops.length || tops.some((top) => !top || glob.test(top))) patterns.add(base)
    else for (const top of tops) patterns.add(`${base}/${top}`)
  }
  for (const pattern of patterns)
    for (const other of patterns) if (pattern.startsWith(`${other}/`)) patterns.delete(pattern)
  return patterns.size ? [...patterns].toSorted().join(',') : undefined
}

/**
 * The job environment behind the egress proxy: `GOPRIVATE` from the panel GitLab forges and the
 * groups of the panel and the config file, so `go` fetches their modules directly through the
 * proxy (which adds the token) instead of the public module proxy and checksum database.
 * Empty when no forge qualifies. Holds no secret.
 */
export async function egressJobEnv(
  store: { config?: Pick<ConfigStore, 'list'> | undefined },
  config: Pick<HoltkeeperConfig, 'groups'>,
): Promise<Record<string, string>> {
  const forgeDocs = (await store.config?.list('forge')) ?? []
  const groupDocs = (await store.config?.list('group')) ?? []
  const value = goPrivate(
    forgeDocs.map(({ id, data }) => ({
      id,
      kind: data.kind,
      url: data.url,
      packages: data.packages,
    })),
    [...groupDocs.map((doc) => doc.data), ...Object.values(config.groups ?? {})],
  )
  return value ? { GOPRIVATE: value } : {}
}

const publicHosts = new Set(['github.com', 'gitlab.com', 'bitbucket.org'])

const topOf = (path: string) => path.replace(/^\/+/, '').split('/')[0] ?? ''

/**
 * `GOPRIVATE`-style patterns of the Go modules that are private: `extra` (the setting), the whole
 * host (with the instance's sub-path) of every forge, and on github.com, gitlab.com and
 * bitbucket.org, where most modules are public, `host/<top>` for the top-level groups the forge's
 * groups include (wildcards left out) and for the top-level namespace of every repository of that
 * forge in `repos`. Sorted, without duplicates.
 */
export function goPrivatePatterns(
  forges: readonly Pick<GoPrivateForge, 'id' | 'url'>[],
  groups: readonly GoPrivateGroup[],
  extra: readonly string[] = [],
  repos: readonly RepoRef[] = [],
): string[] {
  const patterns = new Set(extra)
  for (const forge of forges) {
    let url: URL
    try {
      url = new URL(forge.url)
    } catch {
      continue
    }
    const base = `${url.hostname}${url.pathname.replace(/\/+$/, '')}`
    if (!publicHosts.has(url.hostname)) {
      patterns.add(base)
      continue
    }
    const tops = [
      ...groups.filter((group) => group.forge === forge.id).flatMap((group) => group.include),
      ...repos.filter((repo) => repo.forge === forge.id).map((repo) => repo.path),
    ].map(topOf)
    for (const top of tops) if (top && !glob.test(top)) patterns.add(`${base}/${top}`)
  }
  return [...patterns].toSorted()
}

/** What `privateGoPatterns` reads: panel forges and groups, and the repositories with records. */
export interface GoPrivateSources {
  config?: Pick<ConfigStore, 'list'> | undefined
  analyses?: Pick<AnalysisStore, 'latestHeads'> | undefined
}

/** The forges and groups of the config file `privateGoPatterns` reads. */
export type GoPrivateConfig = Pick<HoltkeeperConfig, 'groups'> & {
  forges?: Readonly<Record<string, { url: string }>> | undefined
}

/**
 * `goPrivatePatterns` over the panel forges and the config file's forges, the groups of both, the
 * repositories with a `depgraph` or `usages` record, and `extra`.
 */
export async function privateGoPatterns(
  store: GoPrivateSources,
  config: GoPrivateConfig | undefined,
  extra: readonly string[],
): Promise<string[]> {
  const forgeDocs = (await store.config?.list('forge')) ?? []
  const groupDocs = (await store.config?.list('group')) ?? []
  const analyses = store.analyses
  const heads = analyses
    ? await Promise.all(['depgraph', 'usages'].map((kind) => analyses.latestHeads({ kind })))
    : []
  const forges = new Map<string, string>()
  for (const [id, forge] of Object.entries(config?.forges ?? {})) forges.set(id, forge.url)
  for (const { id, data } of forgeDocs) forges.set(id, data.url)
  return goPrivatePatterns(
    [...forges].map(([id, url]) => ({ id, url })),
    [...groupDocs.map((doc) => doc.data), ...Object.values(config?.groups ?? {})],
    extra,
    heads.flat().map((head) => head.repo),
  )
}

/**
 * Variables every job command gets, with or without an egress proxy: `GOPRIVATE` with the
 * `privateGoPatterns` and the egress proxy's `goPrivate` patterns, so `go` never asks the public
 * module proxy or checksum database about those modules (`GONOPROXY` and `GONOSUMDB` default to
 * it). Empty when there is no pattern. Holds no secret.
 */
export async function goPrivateJobEnv(
  store: GoPrivateSources,
  config: GoPrivateConfig,
  extra: readonly string[],
): Promise<Record<string, string>> {
  const egress = (await egressJobEnv(store, config)).GOPRIVATE?.split(',') ?? []
  const patterns = new Set([...egress, ...(await privateGoPatterns(store, config, extra))])
  for (const pattern of patterns)
    for (const other of patterns)
      if (pattern !== other && pattern.startsWith(`${other}/`)) patterns.delete(pattern)
  return patterns.size ? { GOPRIVATE: [...patterns].toSorted().join(',') } : {}
}
