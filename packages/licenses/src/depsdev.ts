import { z } from 'zod'

/** One resolved package version, named the way OSV and the dependency graphs name it. */
export interface PackageVersion {
  /** `npm` or `Go`. */
  ecosystem: string
  name: string
  /** Go versions without the `v` prefix. */
  version: string
}

/** Ecosystems whose licenses deps.dev answers for, by their OSV name. */
export const DEPSDEV_ECOSYSTEMS: readonly string[] = ['npm', 'Go']

/** The part of the deps.dev API (https://docs.deps.dev/api/v3/) a license lookup needs. */
export interface DepsDevClient {
  /**
   * The SPDX expressions deps.dev records for one version; empty when it records none or does not
   * know the version. Throws on any other failure, so a failed lookup never reads as "no license".
   */
  licenses(pkg: PackageVersion, options?: { signal?: AbortSignal }): Promise<string[]>
}

/** Options of `depsDevClient`. */
export interface DepsDevClientOptions {
  /** Default: global `fetch`. */
  fetch?: typeof fetch
  /** Default: `https://api.deps.dev`. */
  baseUrl?: string
  /** Each request is aborted after this long. Default 30 s. */
  timeoutMs?: number
}

const versionSchema = z.object({ licenses: z.array(z.string()).nullish() })

const systems: Record<string, string> = { npm: 'npm', Go: 'go' }

/** A `DepsDevClient` over the public deps.dev v3 API, or a mirror speaking it at `baseUrl`. */
export function depsDevClient(options: DepsDevClientOptions = {}): DepsDevClient {
  const base = (options.baseUrl ?? 'https://api.deps.dev').replace(/\/+$/u, '')
  const doFetch = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? 30_000
  return {
    async licenses(pkg, { signal } = {}) {
      const system = systems[pkg.ecosystem]
      if (!system) return []
      const version = pkg.ecosystem === 'Go' ? `v${pkg.version}` : pkg.version
      const url = `${base}/v3/systems/${system}/packages/${encodeURIComponent(pkg.name)}/versions/${encodeURIComponent(version)}`
      const timeout = AbortSignal.timeout(timeoutMs)
      const response = await doFetch(url, {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
      if (response.status === 404) return []
      if (!response.ok)
        throw new Error(`deps.dev answered ${response.status} for ${pkg.name}@${pkg.version}`)
      const parsed = versionSchema.parse(await response.json())
      return (parsed.licenses ?? []).map((license) => license.trim()).filter(Boolean)
    },
  }
}

/** The key of one package version in lookups and caches: `<ecosystem>:<name>@<version>`. */
export const versionKey = (pkg: PackageVersion) => `${pkg.ecosystem}:${pkg.name}@${pkg.version}`

/** Licenses of one version as a cache keeps them, with the time deps.dev was asked. */
export interface CachedLicenses {
  licenses: string[]
  checkedAt: string
}

/** Where looked-up licenses are kept between runs, by `versionKey`. */
export interface LicenseCache {
  read(): Promise<Map<string, CachedLicenses>>
  /** Replaces the cache with `entries`. */
  write(entries: ReadonlyMap<string, CachedLicenses>): Promise<void>
}

/** How long a cached answer is trusted: a known license for a month, none for a day. */
export const LICENSE_TTL_MS = 30 * 86_400_000
export const NO_LICENSE_TTL_MS = 86_400_000

/** Options of `lookupLicenses`. */
export interface LookupLicensesOptions {
  client: DepsDevClient
  cache: LicenseCache
  packages: readonly PackageVersion[]
  now: Date
  /** Requests at once. Default 16. */
  concurrency?: number
  signal?: AbortSignal
}

/** What `lookupLicenses` found. */
export interface LicenseLookup {
  /** Licenses of every distinct version asked for (deps.dev ecosystems only), by `versionKey`. */
  licenses: Map<string, string[]>
  /** Distinct versions asked for. */
  queried: number
  /** Versions deps.dev was asked about because the cache had no fresh answer. */
  fetched: number
}

/**
 * The licenses of every distinct version, from `cache` while its answer is fresh (`LICENSE_TTL_MS`,
 * `NO_LICENSE_TTL_MS` when deps.dev had none) and from deps.dev otherwise. Fresh answers go back to
 * the cache, stale entries no package asked for are dropped. Any deps.dev failure throws before the
 * cache is written, so a failed lookup never reads as "no license".
 */
export async function lookupLicenses({
  client,
  cache,
  packages,
  now,
  concurrency = 16,
  signal,
}: LookupLicensesOptions): Promise<LicenseLookup> {
  const wanted = new Map<string, PackageVersion>()
  for (const pkg of packages)
    if (DEPSDEV_ECOSYSTEMS.includes(pkg.ecosystem)) wanted.set(versionKey(pkg), pkg)
  const cached = await cache.read()
  const fresh = (entry: CachedLicenses | undefined) =>
    entry !== undefined &&
    now.getTime() - Date.parse(entry.checkedAt) <
      (entry.licenses.length ? LICENSE_TTL_MS : NO_LICENSE_TTL_MS)
  const missing = [...wanted].filter(([key]) => !fresh(cached.get(key)))
  const answers = new Map<string, CachedLicenses>()
  const checkedAt = now.toISOString()
  let next = 0
  const worker = async () => {
    while (next < missing.length) {
      const entry = missing[next++]
      if (!entry) return
      const [key, pkg] = entry
      // oxlint-disable-next-line no-await-in-loop -- each worker takes one version at a time
      const licenses = await client.licenses(pkg, signal ? { signal } : {})
      answers.set(key, { licenses, checkedAt })
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, missing.length)) }, worker),
  )

  const kept = new Map<string, CachedLicenses>()
  for (const [key, entry] of cached) if (fresh(entry)) kept.set(key, entry)
  for (const [key, entry] of answers) kept.set(key, entry)
  if (answers.size || kept.size !== cached.size) await cache.write(kept)

  const licenses = new Map<string, string[]>()
  for (const key of wanted.keys()) licenses.set(key, kept.get(key)?.licenses ?? [])
  return { licenses, queried: wanted.size, fetched: answers.size }
}

const cacheSchema = z.record(
  z.string(),
  z.object({ licenses: z.array(z.string()), checkedAt: z.string() }),
)

/** A `LicenseCache` in one key of a key-value store (`get`/`set` as `KvStore` has them). */
export function kvLicenseCache(
  kv: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> },
  key = 'license-index:licenses',
): LicenseCache {
  return {
    async read() {
      return new Map(Object.entries(cacheSchema.safeParse(await kv.get(key)).data ?? {}))
    },
    async write(entries) {
      await kv.set(key, Object.fromEntries(entries))
    },
  }
}
