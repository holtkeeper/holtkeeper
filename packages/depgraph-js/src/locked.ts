import { isObject, objectOf, objectsOf, stringOf, stringsOf } from './json.ts'
import type { JsonObject } from './json.ts'
import { type Lockfile, lockfiles } from './lockfile.ts'
import { declaredDependencies } from './workspaces.ts'
import type { JsWorkspace, JsWorkspaces, Manifest } from './workspaces.ts'

/** One dependency of an importer (the root or a workspace) as the lockfile has it. */
export interface LockedDependency {
  name: string
  /**
   * The range the lockfile recorded for the importer, as `package.json` had it when the lockfile
   * was written (yarn berry adds `npm:`); absent where the format records none (yarn classic).
   */
  specifier?: string
  /** Resolved version, `workspace:<path>` for a workspace; absent when the lockfile does not resolve it. */
  version?: string
}

/** The root or a workspace as its lockfile sees it. */
export interface LockedImporter {
  /** Directory relative to the lockfile, `.` for the root. */
  path: string
  /**
   * The lockfile has its own entry with this importer's dependency list. Always `false` for yarn
   * classic, whose lockfile lists no importers; its resolutions come from the `package.json`.
   */
  recorded: boolean
  dependencies: Map<string, LockedDependency>
}

/** What a lockfile resolves, by importer and by package. */
export interface LockIndex {
  file: string
  manager: Lockfile['manager']
  importers: Map<string, LockedImporter>
  /** Every third-party package the lockfile resolves, with its versions sorted. */
  packages: Map<string, string[]>
}

const normalizePath = (path: string) => (path === '' ? '.' : path.replace(/^\.\//, ''))

function npmSpecifiers(content: string) {
  const result = new Map<string, Map<string, string>>()
  for (const [location, entry] of objectsOf(objectOf(JSON.parse(content)).packages)) {
    if (location.includes('node_modules/') || entry.link === true) continue
    result.set(
      normalizePath(location),
      new Map(declaredDependencies(entry).map((dep) => [dep.name, dep.range])),
    )
  }
  return result
}

function pnpmSpecifiers(content: string) {
  const lock = objectOf(Bun.YAML.parse(content))
  const importers: [string, JsonObject][] =
    lock.importers === undefined ? [['.', lock]] : objectsOf(lock.importers)
  const result = new Map<string, Map<string, string>>()
  for (const [path, importer] of importers) {
    const legacy = stringsOf(importer.specifiers)
    const specifiers = new Map<string, string>()
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'])
      for (const [name, value] of Object.entries(objectOf(importer[field]))) {
        const specifier = isObject(value) ? stringOf(value.specifier) : legacy[name]
        if (specifier !== undefined) specifiers.set(name, specifier)
      }
    result.set(normalizePath(path), specifiers)
  }
  return result
}

function bunSpecifiers(content: string) {
  const result = new Map<string, Map<string, string>>()
  for (const [path, entry] of objectsOf(objectOf(Bun.JSONC.parse(content)).workspaces))
    result.set(
      normalizePath(path),
      new Map(declaredDependencies(entry).map((dep) => [dep.name, dep.range])),
    )
  return result
}

function berrySpecifiers(content: string) {
  const result = new Map<string, Map<string, string>>()
  for (const [key, entry] of objectsOf(Bun.YAML.parse(content))) {
    if (key === '__metadata') continue
    const resolution = stringOf(entry.resolution) ?? ''
    const at = resolution.indexOf('@workspace:', 1)
    if (at < 0) continue
    const path = normalizePath(resolution.slice(at + '@workspace:'.length))
    result.set(
      path,
      new Map(
        Object.entries({
          ...stringsOf(entry.peerDependencies),
          ...stringsOf(entry.dependencies),
        }),
      ),
    )
  }
  return result
}

function recordedSpecifiers(lockfile: Lockfile, content: string) {
  if (lockfile.manager === 'npm') return npmSpecifiers(content)
  if (lockfile.manager === 'pnpm') return pnpmSpecifiers(content)
  if (lockfile.manager === 'bun') return bunSpecifiers(content)
  return content.includes('__metadata:') ? berrySpecifiers(content) : undefined
}

/**
 * Indexes what `content` of `lockfile` resolves: every package with its versions, and for each
 * importer its dependencies with the recorded range and resolved version. `workspaces` gives
 * workspace names and paths, and for yarn classic the `package.json` dependencies that are
 * resolved. Throws when the lockfile does not parse.
 */
export function indexLockfile(
  lockfile: Lockfile,
  content: string,
  workspaces: JsWorkspaces,
): LockIndex {
  const graph = lockfile.parse(content, workspaces)
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]))
  const versions = new Map<string, Set<string>>()
  for (const node of graph.nodes)
    if (node.kind === 'package' && node.version !== undefined)
      versions.set(node.name, (versions.get(node.name) ?? new Set()).add(node.version))

  const resolved = new Map<string, Map<string, string>>()
  for (const edge of graph.edges) {
    const from = nodes.get(edge.from)
    const to = nodes.get(edge.to)
    if (from?.kind !== 'workspace' || from.path === undefined || !to) continue
    const version = to.kind === 'workspace' ? `workspace:${to.path ?? to.name}` : to.version
    if (version === undefined) continue
    const deps = resolved.get(from.path) ?? new Map<string, string>()
    if (!deps.has(to.name)) deps.set(to.name, version)
    resolved.set(from.path, deps)
  }

  const specifiers = recordedSpecifiers(lockfile, content)
  const paths = new Set([...resolved.keys(), ...(specifiers?.keys() ?? [])])
  const importers = new Map<string, LockedImporter>()
  for (const path of [...paths].toSorted()) {
    const recorded = specifiers?.get(path)
    const versionsOf = resolved.get(path)
    const dependencies = new Map<string, LockedDependency>()
    for (const name of new Set([...(recorded?.keys() ?? []), ...(versionsOf?.keys() ?? [])])) {
      const specifier = recorded?.get(name)
      const version = versionsOf?.get(name)
      dependencies.set(name, {
        name,
        ...(specifier !== undefined ? { specifier } : {}),
        ...(version !== undefined ? { version } : {}),
      })
    }
    importers.set(path, { path, recorded: recorded !== undefined, dependencies })
  }

  return {
    file: lockfile.file,
    manager: lockfile.manager,
    importers,
    packages: new Map(
      [...versions]
        .toSorted(([a], [b]) => (a < b ? -1 : 1))
        .map(([name, set]) => [name, [...set].toSorted(compareVersions)]),
    ),
  }
}

function compareVersions(a: string, b: string): number {
  try {
    return Bun.semver.order(a, b)
  } catch {
    return a < b ? -1 : a > b ? 1 : 0
  }
}

/** The lockfile format of a file name (`package-lock.json`, `yarn.lock`, ...), if supported. */
export function lockfileOf(file: string): Lockfile | undefined {
  const name = file.split('/').at(-1)
  return lockfiles.find((lockfile) => lockfile.file === name)
}

function toWorkspace(path: string, manifest: Manifest): JsWorkspace {
  const version = stringOf(manifest.version)
  return {
    name: stringOf(manifest.name) ?? (path === '.' ? 'root' : path),
    ...(version ? { version } : {}),
    path,
    manifest,
  }
}

/**
 * A `JsWorkspaces` from manifests already read, keyed by directory (`.` for the root), for when
 * the workspace patterns cannot be expanded (e.g. files read from another commit).
 */
export function workspacesOf(manifests: ReadonlyMap<string, Manifest>): JsWorkspaces {
  const packages = [...manifests]
    .filter(([path]) => path !== '.')
    .toSorted(([a], [b]) => (a < b ? -1 : 1))
    .map(([path, manifest]) => toWorkspace(path, manifest))
  return { source: 'package.json', root: toWorkspace('.', manifests.get('.') ?? {}), packages }
}
