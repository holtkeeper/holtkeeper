import {
  type DevOnlyPackages,
  type InternalPackages,
  type LicensePolicyOptions,
  evaluatePackages,
  resolvePolicy,
  withDevFallback,
} from './analyze.ts'
import { type PackageVersion, versionKey } from './depsdev.ts'
import type { LicensesData } from './model.ts'
import type { ScannedPackage } from './parse.ts'

/** `tool.name` of records built from dependency graphs and deps.dev instead of osv-scanner. */
export const INDEX_TOOL = 'deps.dev'

/** Options of `inventoryLicenses`. */
export interface InventoryLicensesOptions {
  /** Resolved package versions with the lockfile or manifest that pins each, one entry per pair. */
  packages: readonly (PackageVersion & { source: string })[]
  /** Licenses by `versionKey`; versions it lacks have none. */
  licenses: ReadonlyMap<string, readonly string[]>
  policy?: LicensePolicyOptions
  internal?: InternalPackages
  devOnly?: DevOnlyPackages
  /** License files at the repository root; absent when unknown. */
  licenseFiles?: readonly string[]
  /** The day exceptions are checked against, `YYYY-MM-DD`. */
  today: string
}

/**
 * The `licenses` record of a repository from its resolved packages instead of a checkout: one
 * package per version with every source, judged as `analyzeLicenses` judges osv-scanner's output.
 * Packages are sorted by ecosystem, name and version, so equal inputs give equal data.
 */
export function inventoryLicenses({
  packages,
  licenses,
  policy,
  internal,
  devOnly,
  licenseFiles,
  today,
}: InventoryLicensesOptions): LicensesData {
  const merged = new Map<string, ScannedPackage>()
  for (const pkg of packages) {
    const key = versionKey(pkg)
    const known = merged.get(key)
    if (known) {
      if (!known.sources.includes(pkg.source)) known.sources.push(pkg.source)
      continue
    }
    merged.set(key, {
      name: pkg.name,
      version: pkg.version,
      ecosystem: pkg.ecosystem,
      sources: [pkg.source],
      licenses: (licenses.get(key) ?? []).filter((license) => license.toUpperCase() !== 'UNKNOWN'),
    })
  }
  const scanned = [...merged.values()].toSorted((a, b) =>
    versionKey(a).localeCompare(versionKey(b)),
  )
  for (const pkg of scanned) pkg.sources.sort()
  const resolved = resolvePolicy(policy, today)
  return {
    tool: { name: INDEX_TOOL },
    policy: resolved,
    packages: evaluatePackages(
      devOnly ? withDevFallback(scanned, devOnly) : scanned,
      resolved,
      internal,
    ),
    ...(licenseFiles && { project: { licenseFiles: [...licenseFiles] } }),
  }
}

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item)
            .filter(([, field]) => field !== undefined)
            .toSorted(([x], [y]) => x.localeCompare(y)),
        )
      : item,
  )

/**
 * Whether two records judge the same packages the same way under the same policy, with the same
 * project license files; the tool does not count. Lets a caller skip writing a record that changes
 * nothing, also against one osv-scanner made.
 */
export function sameLicensesState(a: LicensesData, b: LicensesData): boolean {
  return licensesState(a) === licensesState(b)
}

function licensesState(data: LicensesData): string {
  return canonical({
    policy: data.policy,
    project: data.project?.licenseFiles ?? null,
    packages: data.packages
      .map((pkg) => ({
        ...pkg,
        sources: pkg.sources.toSorted(),
        licenses: pkg.licenses.toSorted(),
      }))
      .toSorted((x, y) => versionKey(x).localeCompare(versionKey(y))),
  })
}
