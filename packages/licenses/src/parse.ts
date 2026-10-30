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
 * Reads packages and their licenses from osv-scanner JSON. A package found in several lockfiles
 * is listed once with every source; its licenses and groups are the union. `UNKNOWN` entries are
 * dropped when the package also has a real license. Sources are relative to `dir`.
 */
export function parseOsvLicenses(input: unknown, dir: string): ScannedPackage[] {
  const output = osvLicensesOutputSchema.parse(input)
  const packages = new Map<string, ScannedPackage & { groupSet: Set<string> }>()
  for (const result of output.results ?? []) {
    const source = isAbsolute(result.source.path)
      ? relative(dir, result.source.path)
      : result.source.path
    for (const entry of result.packages ?? []) {
      const { name, ecosystem } = entry.package
      const version = entry.package.version ?? ''
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
