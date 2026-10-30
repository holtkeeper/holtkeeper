import type { ApiPackage, ApiSymbol, ApiSymbolKind } from './model.ts'

/** How one exported name differs between two versions. */
export interface ApiChange {
  subpath: string
  name: string
  kind: ApiSymbolKind
  change: 'added' | 'removed' | 'changed' | 'deprecated'
  before?: string
  after?: string
}

/** The smallest version bump a set of changes calls for. */
export type Bump = 'major' | 'minor' | 'patch' | 'none'

/** How a package's API changed between two versions. */
export interface PackageDiff {
  name: string
  from?: string
  to?: string
  added: number
  removed: number
  /** Declarations that differ; they may or may not break callers. */
  changed: number
  deprecated: number
  /** What the changes call for: `major` when something was removed. */
  required: Bump
  /** What the version numbers did; `undefined` when either is missing or not semver. */
  bumped?: Bump
  /** Set when names were removed but the version did not get a major bump (minor for `0.x`). */
  semverWarning?: string
  changes: ApiChange[]
}

/** Declaration text without comments and with whitespace collapsed, for comparing versions. */
export const normalizeSignature = (signature: string) =>
  signature
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()

const parseSemver = (version: string | undefined) => {
  const match = version ? /^v?(\d+)\.(\d+)\.(\d+)/.exec(version) : null
  return match ? match.slice(1, 4).map(Number) : undefined
}

/** Which part of the version moved from `from` to `to`; `undefined` when either is not semver. */
export function versionBump(from: string | undefined, to: string | undefined): Bump | undefined {
  const a = parseSemver(from)
  const b = parseSemver(to)
  if (!a || !b) return undefined
  const [majorA = 0, minorA = 0, patchA = 0] = a
  const [majorB = 0, minorB = 0, patchB = 0] = b
  if (majorB !== majorA) return majorB > majorA ? 'major' : 'none'
  // In 0.x versions a minor bump is the breaking one.
  if (minorB !== minorA) return minorB < minorA ? 'none' : majorA === 0 ? 'major' : 'minor'
  return patchB > patchA ? 'patch' : 'none'
}

const rank: Record<Bump, number> = { none: 0, patch: 1, minor: 2, major: 3 }

const symbolsOf = (pkg: ApiPackage | undefined) => {
  const map = new Map<string, ApiSymbol & { subpath: string }>()
  for (const entry of pkg?.entries ?? [])
    for (const symbol of entry.symbols)
      map.set(`${entry.subpath}\u0000${symbol.name}`, { ...symbol, subpath: entry.subpath })
  return map
}

/**
 * Differences between two versions of one package's API, keyed by subpath and exported name.
 * Either side may be missing (a package added or removed). Changes are sorted removed, changed,
 * deprecated, added, then by subpath and name.
 */
export function diffPackage(
  before: ApiPackage | undefined,
  after: ApiPackage | undefined,
): PackageDiff {
  const old = symbolsOf(before)
  const next = symbolsOf(after)
  const changes: ApiChange[] = []
  for (const [key, symbol] of old) {
    const now = next.get(key)
    const base = { subpath: symbol.subpath, name: symbol.name, kind: now?.kind ?? symbol.kind }
    if (!now) changes.push({ ...base, change: 'removed', before: symbol.signature })
    else if (normalizeSignature(now.signature) !== normalizeSignature(symbol.signature))
      changes.push({ ...base, change: 'changed', before: symbol.signature, after: now.signature })
    else if (symbol.deprecated === undefined && now.deprecated !== undefined)
      changes.push({ ...base, change: 'deprecated', after: now.signature })
  }
  for (const [key, symbol] of next)
    if (!old.has(key))
      changes.push({
        subpath: symbol.subpath,
        name: symbol.name,
        kind: symbol.kind,
        change: 'added',
        after: symbol.signature,
      })
  const order = { removed: 0, changed: 1, deprecated: 2, added: 3 }
  changes.sort(
    (a, b) =>
      order[a.change] - order[b.change] ||
      a.subpath.localeCompare(b.subpath) ||
      a.name.localeCompare(b.name),
  )
  const count = (change: ApiChange['change']) => changes.filter((c) => c.change === change).length
  const removed = count('removed')
  const changed = count('changed')
  const added = count('added')
  const deprecated = count('deprecated')
  const required: Bump = removed ? 'major' : added || changed || deprecated ? 'minor' : 'none'
  const from = before?.version
  const to = after?.version
  const bumped = before && after ? versionBump(from, to) : undefined
  const zero = parseSemver(to)?.[0] === 0
  const semverWarning =
    bumped !== undefined && rank[bumped] < rank[required] && required === 'major'
      ? `${removed} export${removed === 1 ? '' : 's'} removed, but ${from} → ${to} is not a ${zero ? 'minor (0.x)' : 'major'} bump`
      : undefined
  return {
    name: after?.name ?? before?.name ?? '',
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    added,
    removed,
    changed,
    deprecated,
    required,
    ...(bumped ? { bumped } : {}),
    ...(semverWarning ? { semverWarning } : {}),
    changes,
  }
}

/** Per-package differences between two analyses; unchanged packages are left out. */
export function diffApi(
  before: readonly ApiPackage[],
  after: readonly ApiPackage[],
): PackageDiff[] {
  const old = new Map(before.map((pkg) => [pkg.name, pkg]))
  const next = new Map(after.map((pkg) => [pkg.name, pkg]))
  return [...new Set([...old.keys(), ...next.keys()])]
    .toSorted()
    .map((name) => diffPackage(old.get(name), next.get(name)))
    .filter((diff) => diff.changes.length > 0)
}
