import type { DepgraphData } from './analyze.ts'
import type { DepEdgeKind, DepNode } from './model.ts'
import { compareVersions } from './version.ts'

/** A library a workspace depends on directly, with the version the resolver picked. */
export interface DirectDependency {
  ecosystem: string
  name: string
  version: string
  /** Name of the workspace that declares it. */
  workspace: string
  kind: Exclude<DepEdgeKind, 'import'>
}

/** A package the repository itself defines, e.g. a library other repositories install. */
export interface OwnPackage {
  ecosystem: string
  name: string
  version: string
  path?: string
}

const kindRank: Record<DirectDependency['kind'], number> = { prod: 0, peer: 1, optional: 2, dev: 3 }

/**
 * Direct dependencies of every workspace from the `packages` layers, one entry per workspace and
 * library. Where the resolver selects one version per library (Go), the selected version wins over
 * the requested one. A library declared under several kinds keeps the strongest (`prod` first).
 * Sorted by name, then workspace.
 */
export function directDependencies(data: DepgraphData): DirectDependency[] {
  const result = new Map<string, DirectDependency>()
  for (const layer of data.layers) {
    if (layer.id !== 'packages') continue
    const nodes = new Map(layer.graph.nodes.map((node) => [node.id, node]))
    const selected = new Map<string, DepNode>()
    for (const node of layer.graph.nodes)
      if (node.selected) selected.set(`${node.ecosystem}\0${node.name}`, node)

    for (const edge of layer.graph.edges) {
      if (edge.kind === 'import') continue
      const from = nodes.get(edge.from)
      const to = nodes.get(edge.to)
      if (from?.kind !== 'workspace' || to?.kind !== 'package') continue
      const resolved =
        to.selected === false ? (selected.get(`${to.ecosystem}\0${to.name}`) ?? to) : to
      if (resolved.version === undefined) continue
      const key = `${from.name}\0${to.ecosystem}\0${to.name}`
      const existing = result.get(key)
      if (existing && kindRank[existing.kind] <= kindRank[edge.kind]) continue
      result.set(key, {
        ecosystem: to.ecosystem,
        name: to.name,
        version: resolved.version,
        workspace: from.name,
        kind: edge.kind,
      })
    }
  }
  return [...result.values()].toSorted(
    (a, b) => a.name.localeCompare(b.name) || a.workspace.localeCompare(b.workspace),
  )
}

/** Workspaces that carry a version, from every layer, deduplicated by ecosystem and name. */
export function ownPackages(data: DepgraphData): OwnPackage[] {
  const result = new Map<string, OwnPackage>()
  for (const layer of data.layers) {
    for (const node of layer.graph.nodes) {
      if (node.kind !== 'workspace' || node.version === undefined) continue
      const key = `${node.ecosystem}\0${node.name}`
      if (result.has(key)) continue
      result.set(key, {
        ecosystem: node.ecosystem,
        name: node.name,
        version: node.version,
        ...(node.path ? { path: node.path } : {}),
      })
    }
  }
  return [...result.values()].toSorted((a, b) => a.name.localeCompare(b.name))
}

/**
 * How far apart a set of versions is: `major` when they are not semver-compatible (below 1.0 a
 * minor bump is breaking), otherwise the most significant part that differs.
 */
export type VersionDrift = 'none' | 'patch' | 'minor' | 'major'

const numbers = (version: string): [number, number, number] => {
  const core = version.replace(/^v/, '').split(/[-+]/)[0] ?? ''
  const [major = 0, minor = 0, patch = 0] = core
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0)
  return [major, minor, patch]
}

const breaking = ([major, minor]: [number, number, number]) =>
  major > 0 ? `${major}` : `0.${minor}`

/** The drift between the lowest and the highest of `versions`; `none` for fewer than two. */
export function versionDrift(versions: readonly string[]): VersionDrift {
  const distinct = [...new Set(versions)].toSorted(compareVersions)
  const low = distinct[0]
  const high = distinct.at(-1)
  if (low === undefined || high === undefined || low === high) return 'none'
  const [a, b] = [numbers(low), numbers(high)]
  if (breaking(a) !== breaking(b)) return 'major'
  if (a[1] !== b[1]) return 'minor'
  return 'patch'
}

/** One place a library is used across the fleet. */
export interface LibraryUsage<Origin> {
  origin: Origin
  workspace: string
  version: string
  kind: DirectDependency['kind']
  /** How far this version is behind the library's `latest`; `none` when it is the latest. */
  lag: VersionDrift
}

/** A library as the whole fleet uses it. */
export interface FleetLibrary<Origin> {
  ecosystem: string
  name: string
  /** Every version in use, lowest first. */
  versions: string[]
  /** The highest version in use or, when higher, the version in the fleet's own source. */
  latest: string
  /** Drift between the versions in use. */
  drift: VersionDrift
  /** Sorted by version (highest first), then by origin order and workspace. */
  usages: LibraryUsage<Origin>[]
  /** A fleet repository that defines this package, with the version in its source. */
  source?: { origin: Origin; version: string; path?: string }
  /** Usages whose `lag` is not `none`. */
  behind: number
}

const driftRank: Record<VersionDrift, number> = { none: 0, patch: 1, minor: 2, major: 3 }

/**
 * Joins the dependencies of many repositories into one entry per library (same ecosystem and
 * name). `origin` identifies a repository and is copied into usages unchanged. Libraries are sorted
 * by drift (largest first), then by usages behind `latest`, then by usages, then by name.
 */
export function fleetLibraries<Origin>(
  entries: readonly { origin: Origin; data: DepgraphData }[],
): FleetLibrary<Origin>[] {
  type Usage = Omit<LibraryUsage<Origin>, 'lag'>
  const libraries = new Map<string, { ecosystem: string; name: string; usages: Usage[] }>()
  const sources = new Map<string, NonNullable<FleetLibrary<Origin>['source']>>()
  for (const { origin, data } of entries) {
    for (const dep of directDependencies(data)) {
      const key = `${dep.ecosystem}\0${dep.name}`
      const library = libraries.get(key) ?? { ecosystem: dep.ecosystem, name: dep.name, usages: [] }
      library.usages.push({
        origin,
        workspace: dep.workspace,
        version: dep.version,
        kind: dep.kind,
      })
      libraries.set(key, library)
    }
    for (const own of ownPackages(data)) {
      const key = `${own.ecosystem}\0${own.name}`
      const known = sources.get(key)
      if (known && compareVersions(known.version, own.version) >= 0) continue
      sources.set(key, { origin, version: own.version, ...(own.path ? { path: own.path } : {}) })
    }
  }

  return [...libraries.entries()]
    .map(([key, { ecosystem, name, usages }]): FleetLibrary<Origin> => {
      const versions = [...new Set(usages.map((usage) => usage.version))].toSorted(compareVersions)
      const source = sources.get(key)
      const newestUsed = versions.at(-1) ?? ''
      const latest =
        source && compareVersions(source.version, newestUsed) > 0 ? source.version : newestUsed
      const withLag = usages
        .map((usage) => ({
          ...usage,
          lag:
            compareVersions(usage.version, latest) < 0
              ? versionDrift([usage.version, latest])
              : ('none' as const),
        }))
        .toSorted((a, b) => compareVersions(b.version, a.version))
      return {
        ecosystem,
        name,
        versions,
        latest,
        drift: versionDrift(versions),
        usages: withLag,
        ...(source ? { source } : {}),
        behind: withLag.filter((usage) => usage.lag !== 'none').length,
      }
    })
    .toSorted(
      (a, b) =>
        driftRank[b.drift] - driftRank[a.drift] ||
        b.behind - a.behind ||
        b.usages.length - a.usages.length ||
        a.name.localeCompare(b.name),
    )
}
