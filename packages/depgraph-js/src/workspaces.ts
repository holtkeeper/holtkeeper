import { join } from 'node:path'

import { GraphBuilder } from '@holtkeeper/depgraph'
import type { DepEdgeKind, DepNode, GraphSource } from '@holtkeeper/depgraph'

import { objectOf, stringOf, stringsOf } from './json.ts'
import type { JsonObject } from './json.ts'

/** A parsed `package.json`; fields are read defensively, so any object is accepted. */
export type Manifest = JsonObject

/** A package of the repository: the root or one matched by the workspace patterns. */
export interface JsWorkspace {
  /** `name` from `package.json`; the root falls back to `root`, others to their path. */
  name: string
  version?: string
  /** Directory relative to the repository, `.` for the root. */
  path: string
  manifest: Manifest
}

/** Workspace patterns and the packages they match, root first. */
export interface JsWorkspaces {
  /** Where the patterns came from: `package.json` or `pnpm-workspace.yaml`. */
  source: string
  root: JsWorkspace
  /** Packages matched by the patterns, sorted by path; excludes the root. */
  packages: JsWorkspace[]
}

/** Dependency fields in the order their kinds win when a name appears in several. */
const dependencyFields = [
  ['dependencies', 'prod'],
  ['optionalDependencies', 'optional'],
  ['peerDependencies', 'peer'],
  ['devDependencies', 'dev'],
] as const satisfies readonly (readonly [string, DepEdgeKind])[]

/** Every dependency declared in a manifest-shaped object with the kind of the field. */
export function declaredDependencies(manifest: JsonObject) {
  const result: { name: string; range: string; kind: DepEdgeKind }[] = []
  for (const [field, kind] of dependencyFields)
    for (const [name, range] of Object.entries(stringsOf(manifest[field])))
      result.push({ name, range, kind })
  return result
}

/** A JSON file as an object; `undefined` when the file is missing. */
export async function readJsonObject(path: string): Promise<JsonObject | undefined> {
  const file = Bun.file(path)
  if (!(await file.exists())) return undefined
  const value: unknown = await file.json()
  return objectOf(value)
}

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []

/**
 * Reads the root `package.json` and the packages matched by its `workspaces` (array or
 * `{ packages }`) and by `pnpm-workspace.yaml`. Patterns starting with `!` exclude matches;
 * `node_modules` is never searched. Throws when there is no root `package.json`.
 */
export async function readJsWorkspaces(dir: string): Promise<JsWorkspaces> {
  const manifest = await readJsonObject(join(dir, 'package.json'))
  if (!manifest) throw new Error(`no package.json in ${dir}`)

  const patterns: string[] = []
  let source = 'package.json'
  const declared = manifest.workspaces
  patterns.push(...stringList(Array.isArray(declared) ? declared : objectOf(declared).packages))
  const pnpmFile = Bun.file(join(dir, 'pnpm-workspace.yaml'))
  if (await pnpmFile.exists()) {
    const pnpm = stringList(objectOf(Bun.YAML.parse(await pnpmFile.text())).packages)
    if (pnpm.length > 0) {
      patterns.push(...pnpm)
      source = 'pnpm-workspace.yaml'
    }
  }

  const include = patterns.filter((pattern) => !pattern.startsWith('!'))
  const exclude = patterns
    .filter((pattern) => pattern.startsWith('!'))
    .map((pattern) => new Bun.Glob(clean(pattern.slice(1))))
  const paths = new Set<string>()
  const matches = await Promise.all(
    include.map((pattern) =>
      Array.fromAsync(
        new Bun.Glob(`${clean(pattern)}/package.json`).scan({ cwd: dir, onlyFiles: true }),
      ),
    ),
  )
  for (const file of matches.flat()) {
    const path = file.replaceAll('\\', '/').slice(0, -'/package.json'.length)
    if (!path || path.split('/').includes('node_modules')) continue
    if (exclude.some((excluded) => excluded.match(path))) continue
    paths.add(path)
  }

  const manifests = await Promise.all(
    [...paths].toSorted().map(async (path) => ({
      path,
      manifest: await readJsonObject(join(dir, path, 'package.json')),
    })),
  )
  const packages = manifests.flatMap((entry) =>
    entry.manifest ? [toWorkspace(entry.path, entry.manifest)] : [],
  )
  return { source, root: toWorkspace('.', manifest), packages }
}

const clean = (pattern: string) => pattern.replace(/^\.\//, '').replace(/\/+$/, '')

function toWorkspace(path: string, manifest: Manifest): JsWorkspace {
  const version = stringOf(manifest.version)
  return {
    name: stringOf(manifest.name) ?? (path === '.' ? 'root' : path),
    ...(version ? { version } : {}),
    path,
    manifest,
  }
}

/** The graph node of a workspace; its id is the package name in every layer. */
export function workspaceNode(workspace: JsWorkspace): DepNode {
  return {
    id: workspace.name,
    name: workspace.name,
    ...(workspace.version ? { version: workspace.version } : {}),
    ecosystem: 'npm',
    kind: 'workspace',
    path: workspace.path,
  }
}

/**
 * Dependencies between the repository's own packages, from `package.json` and
 * `pnpm-workspace.yaml`. Any range counts, including the `workspace:` protocol. The root is a
 * node when it depends on a workspace or when there are no workspaces at all.
 */
export function jsWorkspaceSource(): GraphSource {
  return {
    name: 'js-workspaces',
    detect: (dir) => Bun.file(join(dir, 'package.json')).exists(),
    async load(dir) {
      const { source, root, packages } = await readJsWorkspaces(dir)
      const byName = new Map(packages.map((pkg) => [pkg.name, pkg]))
      const builder = new GraphBuilder()
      for (const pkg of packages) builder.node(workspaceNode(pkg))
      for (const pkg of [root, ...packages]) {
        for (const dep of declaredDependencies(pkg.manifest)) {
          const target = byName.get(dep.name)
          if (!target || target === pkg || dep.range.startsWith('npm:')) continue
          if (pkg === root) builder.node(workspaceNode(root))
          builder.edge(pkg.name, target.name, dep.kind)
        }
      }
      if (packages.length === 0) builder.node(workspaceNode(root))
      return [{ id: 'workspaces', source, graph: builder.build() }]
    },
  }
}
