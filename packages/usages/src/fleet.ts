import { compareVersions } from '@holtkeeper/depgraph'

import {
  type NameCount,
  type UsageKind,
  type UsageSite,
  type UsagesData,
  type UsedExport,
  usageKinds,
} from './model.ts'

/** The newest `usages` data of one repository; `origin` identifies it, e.g. `forge:path`. */
export interface UsageEntry<Origin = string> {
  origin: Origin
  data: UsagesData
}

/** How one repository uses a package. */
export interface RepoPackageUsage<Origin = string> {
  origin: Origin
  versions: string[]
  ranges: string[]
  workspaces: string[]
  count: number
  files: number
  exports: UsedExport[]
}

/** One export of a package summed over every repository using it. */
export interface FleetExport<Origin = string> {
  name: string
  subpath: string
  count: number
  files: number
  repos: Origin[]
  kinds: Partial<Record<UsageKind, number>>
  members: NameCount[]
  props: NameCount[]
}

/** Who uses a package, which versions, and which of its exports, members and props. */
export interface PackageUsage<Origin = string> {
  name: string
  /** Versions in use, highest first. */
  versions: string[]
  repos: RepoPackageUsage<Origin>[]
  exports: FleetExport<Origin>[]
}

const merge = (into: Map<string, number>, from: readonly NameCount[]) => {
  for (const { name, count } of from) into.set(name, (into.get(name) ?? 0) + count)
}

const top = (counts: Map<string, number>, limit = 100): NameCount[] =>
  [...counts]
    .map(([name, count]) => ({ name, count }))
    .toSorted((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit)

const sortVersions = (versions: Iterable<string>) =>
  [...new Set(versions)].toSorted((a, b) => compareVersions(b, a))

/**
 * Every repository whose newest record uses `name`, most uses first, and its exports summed over
 * them. Repositories that only define the package themselves are left out of `repos`.
 */
export function packageUsage<Origin>(
  entries: readonly UsageEntry<Origin>[],
  name: string,
): PackageUsage<Origin> {
  const repos: RepoPackageUsage<Origin>[] = []
  const exports = new Map<
    string,
    {
      name: string
      subpath: string
      count: number
      files: number
      repos: Origin[]
      kinds: Partial<Record<UsageKind, number>>
      members: Map<string, number>
      props: Map<string, number>
    }
  >()
  for (const { origin, data } of entries) {
    const used = data.packages.find((pkg) => pkg.name === name)
    if (!used) continue
    repos.push({
      origin,
      versions: used.versions,
      ranges: used.ranges,
      workspaces: used.workspaces,
      count: used.count,
      files: used.files,
      exports: used.exports,
    })
    for (const item of used.exports) {
      const key = `${item.subpath}\0${item.name}`
      const current =
        exports.get(key) ??
        exports
          .set(key, {
            name: item.name,
            subpath: item.subpath,
            count: 0,
            files: 0,
            repos: [],
            kinds: {},
            members: new Map(),
            props: new Map(),
          })
          .get(key)
      if (!current) continue
      current.count += item.count
      current.files += item.files
      current.repos.push(origin)
      for (const kind of usageKinds)
        if (item.kinds[kind])
          current.kinds[kind] = (current.kinds[kind] ?? 0) + (item.kinds[kind] ?? 0)
      merge(current.members, item.members)
      merge(current.props, item.props)
    }
  }
  return {
    name,
    versions: sortVersions(repos.flatMap((repo) => repo.versions)),
    repos: repos.toSorted((a, b) => b.count - a.count),
    exports: [...exports.values()]
      .map((item) => ({ ...item, members: top(item.members), props: top(item.props) }))
      .toSorted(
        (a, b) =>
          b.repos.length - a.repos.length || b.count - a.count || a.name.localeCompare(b.name),
      ),
  }
}

/** Which sites `findSites` returns. */
export interface SiteQuery<Origin = string> {
  package: string
  /** Exported name; every export when absent. */
  export?: string
  /** Member path or its start, e.g. `reset` or `().reset`; sites reading it or something below. */
  member?: string
  /** JSX prop passed. */
  prop?: string
  kind?: UsageKind
  /** Only these repositories. */
  origins?: readonly Origin[]
  limit?: number
}

/** One site with where it comes from. */
export interface FoundSite<Origin = string> {
  origin: Origin
  versions: string[]
  export: string
  subpath: string
  site: UsageSite
}

const normalizeMember = (text: string) => text.replaceAll('()', '.()').replace(/^\./, '')

const memberMatches = (member: string | undefined, wanted: string) => {
  if (!member) return false
  const have = normalizeMember(member).split('.')
  const want = normalizeMember(wanted).split('.')
  for (let start = 0; start + want.length <= have.length; start += 1)
    if (want.every((part, i) => have[start + i] === part)) return true
  return false
}

/**
 * Sites matching `query` across the newest records, with snippets, ordered by repository then
 * file. Only kept sites can be returned; `total` counts every matching use, including those a
 * record left out of its sites, when the query does not narrow below an export.
 */
export function findSites<Origin>(
  entries: readonly UsageEntry<Origin>[],
  query: SiteQuery<Origin>,
): { sites: FoundSite<Origin>[]; total: number; more: number } {
  const limit = query.limit ?? 50
  const found: FoundSite<Origin>[] = []
  let total = 0
  for (const { origin, data } of entries) {
    if (query.origins && !query.origins.includes(origin)) continue
    const used = data.packages.find((pkg) => pkg.name === query.package)
    if (!used) continue
    for (const item of used.exports) {
      if (query.export !== undefined && item.name !== query.export) continue
      const matching = item.sites.filter(
        (site) =>
          (!query.member || memberMatches(site.member, query.member)) &&
          (!query.prop || site.props?.includes(query.prop)) &&
          (!query.kind || site.kind === query.kind),
      )
      const narrowed = query.member || query.prop || query.kind
      total += narrowed ? matching.length : item.count
      for (const site of matching)
        found.push({
          origin,
          versions: used.versions,
          export: item.name,
          subpath: item.subpath,
          site,
        })
    }
  }
  return { sites: found.slice(0, limit), total, more: Math.max(0, found.length - limit) }
}

/** The part of an API diff `upgradeImpact` reads; `PackageDiff` changes of api-surface fit. */
export interface UpgradeChange {
  change: 'removed' | 'changed' | 'deprecated' | 'added'
  subpath: string
  name: string
  kind?: string
  before?: string
  after?: string
}

/** How serious one change is for the code that uses it. */
export type ImpactLevel = 'breaking' | 'check' | 'deprecated'

/** Uses one change touches in one repository. */
export interface RepoImpact<Origin = string> {
  origin: Origin
  versions: string[]
  /** Export the uses go through, when it is not the changed one, e.g. `Button` for `ButtonProps`. */
  via?: string
  /** Members or props of the uses that the change removed. */
  members?: string[]
  count: number
  sites: UsageSite[]
}

/** One change of the diff and the code it affects. */
export interface ImpactItem<Origin = string> {
  change: UpgradeChange
  level: ImpactLevel
  /** Members the changed declaration no longer has. */
  removedMembers?: string[]
  repos: RepoImpact<Origin>[]
  count: number
}

/** What upgrading a package does to the repositories using it. */
export interface UpgradeImpact<Origin = string> {
  package: string
  items: ImpactItem<Origin>[]
  /** Repositories with at least one affected use. */
  affected: Origin[]
  /** Repositories using the package without any affected use. */
  unaffected: Origin[]
}

const memberLine = /^\s*(?:readonly\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\??\s*[:(<]/

/** Names of the members a declaration lists one per line, e.g. an interface's properties. */
export function declaredMembers(signature: string | undefined): Set<string> {
  const names = new Set<string>()
  if (!signature) return names
  let depth = 0
  for (const line of signature.split('\n')) {
    const match = depth === 1 ? memberLine.exec(line) : null
    if (match?.[1]) names.add(match[1])
    for (const char of line) {
      if (char === '{') depth += 1
      else if (char === '}') depth -= 1
    }
  }
  return names
}

const sitesLimit = 10

const firstSegment = (member: string | undefined) =>
  member?.replace(/^\(\)\.?/, '').split(/[.(]/)[0] ?? ''

/**
 * The uses an API change between two versions of `package` affects in each repository. Removed
 * exports are `breaking` wherever used; a changed declaration is `breaking` where a use touches a
 * member or prop the new declaration lacks (also through exports whose old declaration mentions
 * the changed one, e.g. props of `Button` for a changed `ButtonProps`), and `check` for its other
 * uses; deprecations are `deprecated`. Added exports are ignored. Matching is by export name.
 */
export function upgradeImpact<Origin>(input: {
  entries: readonly UsageEntry<Origin>[]
  package: string
  changes: readonly UpgradeChange[]
  /** Declarations of the old version by export name, to find exports that use a changed type. */
  declarations?: ReadonlyMap<string, string>
}): UpgradeImpact<Origin> {
  const usage = packageUsage(input.entries, input.package)
  const items: ImpactItem<Origin>[] = []
  const affected = new Set<Origin>()

  for (const change of input.changes) {
    if (change.change === 'added') continue
    const removed =
      change.change === 'changed'
        ? [...declaredMembers(change.before)].filter(
            (name) => !declaredMembers(change.after).has(name),
          )
        : []
    const related = removed.length
      ? [...(input.declarations ?? [])].flatMap(([name, declaration]) =>
          name !== change.name && new RegExp(`\\b${change.name}\\b`).test(declaration)
            ? [name]
            : [],
        )
      : []
    const repos: RepoImpact<Origin>[] = []
    let breaking = change.change === 'removed'
    for (const repo of usage.repos) {
      for (const item of repo.exports) {
        const direct = item.name === change.name
        if (!direct && !related.includes(item.name)) continue
        const touches = (site: UsageSite) =>
          removed.includes(firstSegment(site.member)) ||
          (site.props ?? []).some((prop) => removed.includes(prop))
        const hit = removed.length
          ? [
              ...new Set([
                ...item.members.map((m) => firstSegment(m.name)),
                ...item.props.map((p) => p.name),
              ]),
            ].filter((name) => removed.includes(name))
          : []
        if (!direct && !hit.length) continue
        if (hit.length) breaking = true
        const sites = hit.length ? item.sites.filter(touches) : item.sites
        const count = hit.length
          ? item.members
              .filter((m) => removed.includes(firstSegment(m.name)))
              .reduce((s, m) => s + m.count, 0) +
            item.props.filter((p) => removed.includes(p.name)).reduce((s, p) => s + p.count, 0)
          : item.count
        repos.push({
          origin: repo.origin,
          versions: repo.versions,
          ...(direct ? {} : { via: item.name }),
          ...(hit.length ? { members: hit } : {}),
          count,
          sites: sites.slice(0, sitesLimit),
        })
        affected.add(repo.origin)
      }
    }
    if (!repos.length) continue
    items.push({
      change,
      level: change.change === 'deprecated' ? 'deprecated' : breaking ? 'breaking' : 'check',
      ...(removed.length ? { removedMembers: removed } : {}),
      repos: repos.toSorted((a, b) => b.count - a.count),
      count: repos.reduce((sum, repo) => sum + repo.count, 0),
    })
  }

  const rank: Record<ImpactLevel, number> = { breaking: 0, check: 1, deprecated: 2 }
  return {
    package: input.package,
    items: items.toSorted((a, b) => rank[a.level] - rank[b.level] || b.count - a.count),
    affected: [...affected],
    unaffected: usage.repos.map((repo) => repo.origin).filter((origin) => !affected.has(origin)),
  }
}

/** Packages a repository uses, most used first: a compact view of one record. */
export function repoPackages(data: UsagesData) {
  return data.packages.map((pkg) => ({
    name: pkg.name,
    versions: pkg.versions,
    ranges: pkg.ranges,
    local: pkg.local ?? false,
    count: pkg.count,
    files: pkg.files,
    exports: pkg.exports.length,
  }))
}

/** How many repositories use a package and how often, summed over every record. */
export interface UsedByCount {
  repos: number
  count: number
  files: number
}

/**
 * Repositories, uses and files of each of `names` over every record; a name nothing uses maps to
 * zeros. Cheaper than `packageUsage` per name when only the totals are wanted.
 */
export function usedByCounts<Origin>(
  entries: readonly UsageEntry<Origin>[],
  names: readonly string[],
): Map<string, UsedByCount> {
  const counts = new Map(names.map((name) => [name, { repos: 0, count: 0, files: 0 }]))
  for (const { data } of entries)
    for (const pkg of data.packages) {
      const current = counts.get(pkg.name)
      if (!current) continue
      current.repos += 1
      current.count += pkg.count
      current.files += pkg.files
    }
  return counts
}
