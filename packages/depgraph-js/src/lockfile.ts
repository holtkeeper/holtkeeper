import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import {
  type DepGraph,
  type GraphLayer,
  type GraphSource,
  PartialLoadError,
} from '@holtkeeper/depgraph'

import { stringOf } from './json.ts'
import { parseBunLock } from './lockfiles/bun.ts'
import { parseNpmLock } from './lockfiles/npm.ts'
import { parsePnpmLock } from './lockfiles/pnpm.ts'
import type { LockfileParser } from './lockfiles/shared.ts'
import { parseYarnLock } from './lockfiles/yarn.ts'
import { readJsWorkspaces, readJsonObject } from './workspaces.ts'

/** A lockfile format this package reads. */
export interface Lockfile {
  file: string
  /** Package manager name as written in the `packageManager` field of `package.json`. */
  manager: 'pnpm' | 'bun' | 'npm' | 'yarn'
  parse: LockfileParser
}

/** Supported lockfiles in the order they are preferred when several are present. */
export const lockfiles: readonly Lockfile[] = [
  { file: 'pnpm-lock.yaml', manager: 'pnpm', parse: parsePnpmLock },
  { file: 'bun.lock', manager: 'bun', parse: parseBunLock },
  { file: 'package-lock.json', manager: 'npm', parse: parseNpmLock },
  { file: 'npm-shrinkwrap.json', manager: 'npm', parse: parseNpmLock },
  { file: 'yarn.lock', manager: 'yarn', parse: parseYarnLock },
]

/**
 * The lockfile to read in `dir`: the one matching `packageManager` from `package.json` when
 * present, otherwise the first existing one in `lockfiles` order.
 */
export async function findLockfile(dir: string): Promise<Lockfile | undefined> {
  const present: Lockfile[] = []
  for (const lockfile of lockfiles)
    if (await Bun.file(join(dir, lockfile.file)).exists()) present.push(lockfile)
  if (present.length < 2) return present[0]
  const manifest = await readJsonObject(join(dir, 'package.json'))
  const manager = stringOf(manifest?.packageManager)?.split('@')[0]
  return present.find((lockfile) => lockfile.manager === manager) ?? present[0]
}

const skipped = new Set(['node_modules', 'vendor', 'testdata'])

/**
 * Directories below `dir` (relative, never `.`) holding a lockfile `findLockfile` reads, at most
 * `depth` levels deep; `node_modules`, `vendor`, `testdata` and hidden directories are skipped.
 * These are separate projects with their own install, as osv-scanner finds them.
 */
export async function findNestedProjects(dir: string, depth = 4): Promise<string[]> {
  const found: string[] = []
  const names = new Set(lockfiles.map((lockfile) => lockfile.file))
  const walk = async (relative: string, level: number): Promise<void> => {
    const entries = await readdir(join(dir, relative), { withFileTypes: true }).catch(() => [])
    if (relative !== '.' && entries.some((entry) => entry.isFile() && names.has(entry.name)))
      found.push(relative)
    if (level >= depth) return
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name)))
      if (entry.isDirectory() && !skipped.has(entry.name) && !entry.name.startsWith('.'))
        // oxlint-disable-next-line no-await-in-loop
        await walk(relative === '.' ? entry.name : `${relative}/${entry.name}`, level + 1)
  }
  await walk('.', 0)
  return found
}

/**
 * A nested project's graph as seen from the repository root: workspace paths get the project's
 * directory in front, and an unnamed project root (`root`) is named after that directory so it
 * does not read as the repository's own root.
 */
function relocate(graph: DepGraph, prefix: string): DepGraph {
  const renamed = new Map<string, string>()
  const nodes = graph.nodes.map((node) => {
    if (node.kind !== 'workspace') return node
    const path = node.path === undefined || node.path === '.' ? prefix : `${prefix}/${node.path}`
    if (node.id !== 'root' || node.path !== '.') return { ...node, path }
    renamed.set(node.id, prefix)
    return { ...node, id: prefix, name: prefix, path }
  })
  const id = (value: string) => renamed.get(value) ?? value
  return {
    nodes,
    edges: graph.edges.map((edge) => ({ ...edge, from: id(edge.from), to: id(edge.to) })),
  }
}

async function lockfileLayer(dir: string, prefix?: string): Promise<GraphLayer | undefined> {
  const root = prefix === undefined ? dir : join(dir, prefix)
  const lockfile = await findLockfile(root)
  if (!lockfile) return undefined
  const [content, workspaces] = await Promise.all([
    Bun.file(join(root, lockfile.file)).text(),
    readJsWorkspaces(root),
  ])
  const graph = lockfile.parse(content, workspaces)
  return prefix === undefined
    ? { id: 'packages', source: lockfile.file, graph }
    : { id: 'packages', source: `${prefix}/${lockfile.file}`, graph: relocate(graph, prefix) }
}

/**
 * The resolved package graphs from the lockfiles (`pnpm-lock.yaml`, `bun.lock`,
 * `package-lock.json`, `npm-shrinkwrap.json` or `yarn.lock`): one `packages` layer for the root
 * (source: the lockfile name) and one for every nested project with its own lockfile
 * (`findNestedProjects`, source: `<dir>/<lockfile>`, workspace paths relative to the repository).
 * Workspaces are nodes with the same ids as in the workspace layer; packages are `name@version`.
 * A nested project that fails to load is reported through `PartialLoadError`; the rest still load.
 */
export function jsLockfileSource(options: { depth?: number } = {}): GraphSource {
  const depth = options.depth ?? 4
  return {
    name: 'js-lockfile',
    detect: async (dir) =>
      (await findLockfile(dir)) !== undefined || (await findNestedProjects(dir, depth)).length > 0,
    async load(dir) {
      const root = await lockfileLayer(dir)
      const nested = await Promise.all(
        (await findNestedProjects(dir, depth)).map(async (prefix) => {
          try {
            return { layer: await lockfileLayer(dir, prefix) }
          } catch (error) {
            return { error: `${prefix}: ${error instanceof Error ? error.message : String(error)}` }
          }
        }),
      )
      const layers = [root, ...nested.map((each) => each.layer)].filter(
        (layer): layer is GraphLayer => layer !== undefined,
      )
      const errors = nested.flatMap((each) => (each.error === undefined ? [] : [each.error]))
      if (errors.length) throw new PartialLoadError(layers, errors)
      return layers
    },
  }
}
