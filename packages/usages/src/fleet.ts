import { compareVersions } from '@holtkeeper/depgraph'
import { libraryOfModule } from '@holtkeeper/go-source'

import {
  type NameCount,
  type UsageEcosystem,
  type UsageKind,
  type UsageSite,
  type UsagesData,
  type UsedExport,
  type UsedPackage,
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
  /** The package as records name it: for Go, the module path. */
  name: string
  /** Absent for npm. */
  ecosystem?: UsageEcosystem
  /**
   * Set when the query named a Go package inside a module (`example.com/m/sub` → `./sub`): only
   * that package's exports are counted.
   */
  subpath?: string
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

/** A package name as a query gave it, mapped onto the names records use. */
export interface ResolvedPackage {
  name: string
  ecosystem?: UsageEcosystem
  /** The Go package inside the module `name` the query named; absent for the whole package. */
  subpath?: string
  /**
   * Go: `name` is a module path without `/vN` and records hold other majors of it
   * (`name/v2`, ...), so every major counts as one package.
   */
  family?: true
}

/**
 * Maps a queried name onto the records: a package some record names exactly is taken as is (for
 * a Go module that means every package of the module); otherwise a Go import path resolves to the
 * longest Go module path any record names that is a prefix at a `/` boundary, with the rest as
 * `subpath` (`./sub/pkg`). A Go module path without `/vN` that records also hold other majors of
 * comes back as a `family`, all majors merged. Names nothing matches come back unchanged.
 */
export function resolveUsedPackage<Origin>(
  entries: readonly UsageEntry<Origin>[],
  name: string,
): ResolvedPackage {
  let best: UsedPackage | undefined
  let exact: UsedPackage | undefined
  let family = false
  for (const { data } of entries)
    for (const pkg of data.packages) {
      if (pkg.name === name) exact ??= pkg
      else if (pkg.ecosystem === 'Go' && libraryOfModule(pkg.name) === name) family = true
      else if (
        pkg.ecosystem === 'Go' &&
        name.startsWith(`${pkg.name}/`) &&
        (!best || pkg.name.length > best.name.length)
      )
        best = pkg
    }
  if (family) return { name, ecosystem: 'Go', family: true }
  if (exact) return { name, ...(exact.ecosystem ? { ecosystem: exact.ecosystem } : {}) }
  return best
    ? { name: best.name, ecosystem: 'Go', subpath: `./${name.slice(best.name.length + 1)}` }
    : { name }
}

/** The record's use of a resolved package; every major merged into one for a Go `family`. */
function usedIn(data: UsagesData, resolved: ResolvedPackage): UsedPackage | undefined {
  if (!resolved.family) return data.packages.find((pkg) => pkg.name === resolved.name)
  const majors = data.packages.filter(
    (pkg) => pkg.ecosystem === 'Go' && libraryOfModule(pkg.name) === resolved.name,
  )
  if (majors.length < 2) return majors[0]
  return {
    name: resolved.name,
    ecosystem: 'Go',
    versions: sortVersions(majors.flatMap((pkg) => pkg.versions)),
    ranges: [...new Set(majors.flatMap((pkg) => pkg.ranges))].toSorted(),
    workspaces: [...new Set(majors.flatMap((pkg) => pkg.workspaces))].toSorted(),
    ...(majors.every((pkg) => pkg.local) ? { local: true } : {}),
    count: majors.reduce((sum, pkg) => sum + pkg.count, 0),
    files: majors.reduce((sum, pkg) => sum + pkg.files, 0),
    exports: majors.flatMap((pkg) => pkg.exports),
  }
}

/**
 * Every repository whose newest record uses `name`, most uses first, and its exports summed over
 * them. Repositories that only define the package themselves are left out of `repos`. `name` may
 * also be a Go import path inside a module (see `resolveUsedPackage`): then only that package's
 * exports count, and each repository's `files` is the most files any of them is used in.
 */
export function packageUsage<Origin>(
  entries: readonly UsageEntry<Origin>[],
  query: string,
): PackageUsage<Origin> {
  const resolved = resolveUsedPackage(entries, query)
  const { name, subpath } = resolved
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
    const used = usedIn(data, resolved)
    if (!used) continue
    const picked =
      subpath === undefined ? used.exports : used.exports.filter((item) => item.subpath === subpath)
    if (!picked.length) continue
    repos.push({
      origin,
      versions: used.versions,
      ranges: used.ranges,
      workspaces: used.workspaces,
      count: subpath === undefined ? used.count : picked.reduce((sum, item) => sum + item.count, 0),
      files: subpath === undefined ? used.files : Math.max(...picked.map((item) => item.files)),
      exports: picked,
    })
    for (const item of picked) {
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
    ...(resolved.ecosystem ? { ecosystem: resolved.ecosystem } : {}),
    ...(subpath !== undefined ? { subpath } : {}),
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
  /** Package name; for Go a module path or any import path inside it (see `resolveUsedPackage`). */
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
  const resolved = resolveUsedPackage(entries, query.package)
  const { subpath } = resolved
  let total = 0
  for (const { origin, data } of entries) {
    if (query.origins && !query.origins.includes(origin)) continue
    const used = usedIn(data, resolved)
    if (!used) continue
    for (const item of used.exports) {
      if (subpath !== undefined && item.subpath !== subpath) continue
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
  /** Ecosystem of the used package; absent for npm. */
  ecosystem?: UsageEcosystem
  items: ImpactItem<Origin>[]
  /** Repositories with at least one affected use. */
  affected: Origin[]
  /** Repositories using the package without any affected use. */
  unaffected: Origin[]
  /**
   * Go interfaces whose new declaration only adds methods, with the repositories using them. No
   * use of them breaks, so they are not `items`; types implementing them outside the library must
   * add `members`, and usage records do not show implementations.
   */
  widened?: WidenedInterface<Origin>[]
  /**
   * Go: repositories using the package whose newest record was read without the type checker,
   * so methods called on values the package returns are missing from their uses.
   */
  untyped?: UntypedUser<Origin>[]
}

/** A Go interface an upgrade only adds methods to. */
export interface WidenedInterface<Origin = string> {
  name: string
  subpath: string
  /** Methods the new declaration adds. */
  members: string[]
  /** Repositories using the interface. */
  repos: Origin[]
}

/** A repository whose uses were read without types, and why when the record says. */
export interface UntypedUser<Origin = string> {
  origin: Origin
  reason?: string
}

const memberLine = /^\s*(?:readonly\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\??\s*[:(<]/

const goIdent = '[\\p{L}_][\\p{L}\\p{N}_]*'
const goDeclaration = new RegExp(
  `^type\\s+${goIdent}(?:\\[[^\\]]*\\])?\\s+(?:struct|interface)\\s*\\{`,
  'u',
)
const goMethod = new RegExp(`^\\s*(${goIdent})\\s*\\(`, 'u')
const goFields = new RegExp(`^\\s*(${goIdent}(?:\\s*,\\s*${goIdent})*)\\s+[^\\s/]`, 'u')
const goEmbedded = new RegExp(
  `^\\s*\\*?(?:${goIdent}\\.)?(${goIdent})(?:\\[.*\\])?\\s*(?:\x60[^\x60]*\x60)?\\s*$`,
  'u',
)

/** Member names one line of a Go struct or interface body declares: fields, methods or embeds. */
function goMembers(line: string): string[] {
  if (/^\s*(?:\/\/|~)/.test(line)) return []
  const method = goMethod.exec(line)?.[1]
  if (method) return [method]
  const fields = goFields.exec(line)?.[1]
  if (fields) return fields.split(',').map((name) => name.trim())
  const embedded = goEmbedded.exec(line)?.[1]
  return embedded ? [embedded] : []
}

/**
 * Names of the members a declaration lists one per line, e.g. an interface's properties; for a Go
 * `type X struct {…}` or `type X interface {…}`, its field names (embedded types by their type
 * name) and interface methods.
 */
export function declaredMembers(signature: string | undefined): Set<string> {
  const names = new Set<string>()
  if (!signature) return names
  const go = goDeclaration.test(signature)
  let depth = 0
  for (const line of signature.split('\n')) {
    if (depth === 1 && go) for (const name of goMembers(line)) names.add(name)
    const match = depth === 1 && !go ? memberLine.exec(line) : null
    if (match?.[1]) names.add(match[1])
    for (const char of line) {
      if (char === '{') depth += 1
      else if (char === '}') depth -= 1
    }
  }
  return names
}

const goInterface = new RegExp(`^type\\s+${goIdent}(?:\\[[^\\]]*\\])?\\s+interface\\s*\\{`, 'u')

const bodyLines = (signature: string) =>
  signature
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('//'))

/**
 * Methods a Go interface gained when its new declaration keeps every line of the old one and
 * only adds members; empty for anything else, such as a changed or removed method.
 */
export function addedInterfaceMethods(before: string | undefined, after: string | undefined) {
  if (!before || !after || !goInterface.test(before) || !goInterface.test(after)) return []
  const kept = new Set(bodyLines(after))
  if (!bodyLines(before).every((line) => kept.has(line))) return []
  const old = declaredMembers(before)
  return [...declaredMembers(after)].filter((name) => !old.has(name))
}

const sitesLimit = 10

const onlySubpath = <Origin>(
  usage: PackageUsage<Origin>,
  subpath: string,
): PackageUsage<Origin> => ({
  ...usage,
  repos: usage.repos.flatMap((repo) => {
    const exports = repo.exports.filter((item) => item.subpath === subpath)
    return exports.length ? [{ ...repo, exports }] : []
  }),
})

function methodImpact<Origin>(
  repos: readonly RepoPackageUsage<Origin>[],
  change: UpgradeChange,
  type: string,
  method: string,
): ImpactItem<Origin> | undefined {
  const hits: RepoImpact<Origin>[] = []
  for (const repo of repos)
    for (const item of repo.exports) {
      if (item.name !== type) continue
      const count = item.members
        .filter((m) => firstSegment(m.name) === method)
        .reduce((sum, m) => sum + m.count, 0)
      if (!count) continue
      hits.push({
        origin: repo.origin,
        versions: repo.versions,
        ...(change.change === 'removed' ? { members: [method] } : {}),
        count,
        sites: item.sites
          .filter((site) => firstSegment(site.member) === method)
          .slice(0, sitesLimit),
      })
    }
  if (!hits.length) return undefined
  return {
    change,
    level:
      change.change === 'removed'
        ? 'breaking'
        : change.change === 'deprecated'
          ? 'deprecated'
          : 'check',
    repos: hits.toSorted((a, b) => b.count - a.count),
    count: hits.reduce((sum, repo) => sum + repo.count, 0),
  }
}

const firstSegment = (member: string | undefined) =>
  member?.replace(/^\(\)\.?/, '').split(/[.(]/)[0] ?? ''

/**
 * The uses an API change between two versions of `package` affects in each repository. Removed
 * exports are `breaking` wherever used; a changed declaration is `breaking` where a use touches a
 * member or prop the new declaration lacks (also through exports whose old declaration mentions
 * the changed one, e.g. props of `Button` for a changed `ButtonProps`), and `check` for its other
 * uses; deprecations are `deprecated`. Added exports are ignored. Matching is by export name.
 *
 * For Go, `package` is the import path of one package (`ApiPackage.name`): uses count only where
 * `importPath(module, subpath)` equals it. A method symbol `Type.Method` matches uses of export
 * `Type` reading member `Method` (method expressions such as `pkg.Type.Method`); removing it is
 * `breaking` for them, changing it `check`. Struct fields and interface methods are members
 * (`declaredMembers`), and keyed composite literal fields are props. An interface that only gains
 * methods (`addedInterfaceMethods`) breaks no use, only implementations, so it goes to `widened`
 * instead of `items`. Users whose record ran without the type checker are listed in `untyped`.
 */
export function upgradeImpact<Origin>(input: {
  entries: readonly UsageEntry<Origin>[]
  package: string
  changes: readonly UpgradeChange[]
  /** Declarations of the old version by export name, to find exports that use a changed type. */
  declarations?: ReadonlyMap<string, string>
}): UpgradeImpact<Origin> {
  const found = packageUsage(input.entries, input.package)
  const go = found.ecosystem === 'Go'
  const usage = go ? onlySubpath(found, found.subpath ?? '.') : found
  const items: ImpactItem<Origin>[] = []
  const affected = new Set<Origin>()
  const widened: WidenedInterface<Origin>[] = []

  for (const change of input.changes) {
    if (change.change === 'added') continue
    const gained =
      go && change.change === 'changed' ? addedInterfaceMethods(change.before, change.after) : []
    if (gained.length) {
      widened.push({
        name: change.name,
        subpath: change.subpath,
        members: gained,
        repos: usage.repos
          .filter((repo) => repo.exports.some((item) => item.name === change.name))
          .map((repo) => repo.origin),
      })
      continue
    }
    const dot = go ? change.name.indexOf('.') : -1
    if (dot > 0) {
      const item = methodImpact(
        usage.repos,
        change,
        change.name.slice(0, dot),
        change.name.slice(dot + 1),
      )
      if (!item) continue
      for (const repo of item.repos) affected.add(repo.origin)
      items.push(item)
      continue
    }
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
  const users = new Set(usage.repos.map((repo) => repo.origin))
  const untyped = go
    ? input.entries.flatMap(({ origin, data }): UntypedUser<Origin>[] =>
        users.has(origin) && data.types.status !== 'used'
          ? [{ origin, ...(data.types.reason ? { reason: data.types.reason } : {}) }]
          : [],
      )
    : []
  return {
    package: input.package,
    ...(found.ecosystem ? { ecosystem: found.ecosystem } : {}),
    items: items.toSorted((a, b) => rank[a.level] - rank[b.level] || b.count - a.count),
    affected: [...affected],
    unaffected: usage.repos.map((repo) => repo.origin).filter((origin) => !affected.has(origin)),
    ...(widened.length ? { widened } : {}),
    ...(untyped.length ? { untyped } : {}),
  }
}

/** Packages a repository uses, most used first: a compact view of one record. */
export function repoPackages(data: UsagesData) {
  return data.packages.map((pkg) => ({
    name: pkg.name,
    ecosystem: pkg.ecosystem ?? 'npm',
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
