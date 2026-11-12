import { isAbsolute, relative } from 'node:path'

import { z } from 'zod'

/** The subset of `osv-scanner scan source --all-packages --licenses --format json` that packages come from. */
export const osvLicensesOutputSchema = z.object({
  results: z
    .array(
      z.object({
        source: z.object({ path: z.string(), type: z.string().nullish() }),
        packages: z
          .array(
            z.object({
              package: z.object({
                name: z.string(),
                version: z.string().nullish(),
                ecosystem: z.string(),
              }),
              licenses: z.array(z.string()).nullish(),
              dependency_groups: z.array(z.string()).nullish(),
            }),
          )
          .nullish(),
      }),
    )
    .nullish(),
})

/** A package as osv-scanner reports it, merged over every source it appears in. */
export interface ScannedPackage {
  name: string
  version: string
  ecosystem: string
  sources: string[]
  licenses: string[]
  groups?: string[]
}

/**
 * The npm package behind a tarball URL, as osv-scanner names yarn.lock entries resolved from a
 * registry it does not recognize (ecosystem `GIT`): `<registry>/<name>/-/<file>-<version>.tgz`,
 * e.g. a GitLab package registry's `/api/v4/projects/1/packages/npm/@acme/ui/-/@acme/ui-1.2.3.tgz`.
 * `undefined` when `name` is not such a URL.
 */
export function npmTarball(name: string): { name: string; version: string } | undefined {
  let path: string
  try {
    const url = new URL(name)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
    path = decodeURIComponent(url.pathname)
  } catch {
    return undefined
  }
  const split = path.lastIndexOf('/-/')
  if (split < 0) return undefined
  const segments = path.slice(0, split).split('/')
  const last = segments.at(-1)
  const scope = segments.at(-2)
  if (!last) return undefined
  const pkg = scope?.startsWith('@') ? `${scope}/${last}` : last
  const file = path.slice(split + 3).replace(/^@[^/]+\//, '')
  const prefix = `${last}-`
  if (!file.startsWith(prefix) || !file.endsWith('.tgz')) return undefined
  const version = file.slice(prefix.length, -'.tgz'.length)
  return version ? { name: pkg, version } : undefined
}

const normalized = (pkg: { name: string; version?: string | null; ecosystem: string }) => {
  const tarball = npmTarball(pkg.name)
  return tarball
    ? { ...tarball, ecosystem: 'npm' }
    : { name: pkg.name, version: pkg.version ?? '', ecosystem: pkg.ecosystem }
}

/**
 * Reads packages and their licenses from osv-scanner JSON. Packages osv-scanner names by an npm
 * tarball URL (see `npmTarball`) become the npm package and version the URL points at. A package
 * found in several lockfiles is listed once with every source; its licenses and groups are the
 * union. `UNKNOWN` entries are dropped when the package also has a real license. Sources are
 * relative to `dir`.
 */
export function parseOsvLicenses(input: unknown, dir: string): ScannedPackage[] {
  const output = osvLicensesOutputSchema.parse(input)
  const packages = new Map<string, ScannedPackage & { groupSet: Set<string> }>()
  for (const result of output.results ?? []) {
    const source = isAbsolute(result.source.path)
      ? relative(dir, result.source.path)
      : result.source.path
    for (const entry of result.packages ?? []) {
      const { name, version, ecosystem } = normalized(entry.package)
      const key = `${ecosystem}\0${name}\0${version}`
      let pkg = packages.get(key)
      if (!pkg)
        packages.set(
          key,
          (pkg = { name, version, ecosystem, sources: [], licenses: [], groupSet: new Set() }),
        )
      if (!pkg.sources.includes(source)) pkg.sources.push(source)
      for (const license of entry.licenses ?? []) {
        const trimmed = license.trim()
        if (trimmed && !pkg.licenses.includes(trimmed)) pkg.licenses.push(trimmed)
      }
      for (const group of entry.dependency_groups ?? []) pkg.groupSet.add(group)
    }
  }
  return [...packages.values()]
    .map(({ groupSet, ...pkg }): ScannedPackage => {
      pkg.licenses = pkg.licenses.filter((license) => license.toUpperCase() !== 'UNKNOWN')
      if (groupSet.size > 0) pkg.groups = [...groupSet].toSorted()
      return pkg
    })
    .toSorted((a, b) =>
      `${a.ecosystem}\0${a.name}\0${a.version}`.localeCompare(
        `${b.ecosystem}\0${b.name}\0${b.version}`,
      ),
    )
}
