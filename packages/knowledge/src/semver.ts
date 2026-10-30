import type { KnowledgePackage } from '@holtkeeper/store'

import type { TaskPackage } from './model.ts'

/** The first version-looking part of `value` as a full `x.y.z`: `^18.2` → `18.2.0`, `v19` → `19.0.0`. */
export function coerceVersion(value: string): string | undefined {
  const match = /(\d+)(?:\.(\d+))?(?:\.(\d+))?(-[0-9A-Za-z.-]+)?/.exec(value)
  if (!match) return undefined
  return `${match[1]}.${match[2] ?? 0}.${match[3] ?? 0}${match[4] ?? ''}`
}

/**
 * The range of versions compatible with `version` by semver rules: `18.3.1` → `>=18 <19`; below
 * 1.0 the minor is the breaking part, so `0.14.2` → `>=0.14 <0.15`.
 */
export function compatibleRange(version: string): string | undefined {
  const coerced = coerceVersion(version)
  if (!coerced) return undefined
  const [major = 0, minor = 0] = coerced.split('.').map((part) => Number.parseInt(part, 10))
  return major === 0 ? `>=0.${minor} <0.${minor + 1}` : `>=${major} <${major + 1}`
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/**
 * Whether a task working on `task` touches what `entry` is about: same ecosystem and name, and
 * one of the task's versions inside one of the entry's ranges. Missing versions or ranges on
 * either side count as overlapping, so an unversioned note about `react` applies to every react
 * task.
 */
export function packageOverlaps(entry: KnowledgePackage, task: TaskPackage): boolean {
  if (!same(entry.ecosystem, task.ecosystem) || !same(entry.name, task.name)) return false
  const ranges = [entry.from, entry.to].filter((range) => range !== undefined)
  const versions = [task.from, task.to].flatMap((value) => {
    const version = value === undefined ? undefined : coerceVersion(value)
    return version ? [version] : []
  })
  if (!ranges.length || !versions.length) return true
  return versions.some((version) => ranges.some((range) => Bun.semver.satisfies(version, range)))
}

/** Whether any of `entries` overlaps any of `task` (see `packageOverlaps`). */
export const packagesOverlap = (
  entries: readonly KnowledgePackage[],
  task: readonly TaskPackage[],
): boolean => entries.some((entry) => task.some((pkg) => packageOverlaps(entry, pkg)))

/** `react >=18 <19 → >=19 <20`, `react from >=18 <19`, or just `react`. */
export function describePackage(pkg: KnowledgePackage): string {
  if (pkg.from && pkg.to) return `${pkg.name} ${pkg.from} → ${pkg.to}`
  if (pkg.from) return `${pkg.name} from ${pkg.from}`
  if (pkg.to) return `${pkg.name} to ${pkg.to}`
  return pkg.name
}
