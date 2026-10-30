import { GraphBuilder, compareVersions } from '@holtkeeper/depgraph'
import type { DepGraph, DepNode } from '@holtkeeper/depgraph'

import type { GoWorkspaceModule } from './gomod.ts'

/** Pseudo-modules `go mod graph` prints for the language and toolchain versions. */
const pseudo = new Set(['go', 'toolchain'])

function moduleNode(module: GoWorkspaceModule): DepNode {
  return {
    id: module.module,
    name: module.module,
    ecosystem: 'Go',
    kind: 'workspace',
    path: module.dir,
  }
}

/** Dependencies between workspace modules, from their `require` directives. */
export function goWorkspaceGraph(modules: readonly GoWorkspaceModule[]): DepGraph {
  const builder = new GraphBuilder()
  const local = new Set(modules.map((module) => module.module))
  for (const module of modules) builder.node(moduleNode(module))
  for (const module of modules)
    for (const required of module.mod.require)
      if (local.has(required.path) && required.path !== module.module)
        builder.edge(module.module, required.path, 'prod')
  return builder.build()
}

/**
 * Turns `go mod graph` output into a package graph. Main and workspace modules become workspace
 * nodes whatever version they are referred to by; every other `path@version` is a package node.
 * Minimal version selection builds with the highest version in the graph, so that node is marked
 * `selected: true` and the other versions of the same module `selected: false`.
 */
export function parseGoModGraph(output: string, modules: readonly GoWorkspaceModule[]): DepGraph {
  const local = new Map(modules.map((module) => [module.module, module]))
  const builder = new GraphBuilder()
  const versions = new Map<string, Set<string>>()

  const nodeId = (token: string): string | undefined => {
    const at = token.lastIndexOf('@')
    const path = at > 0 ? token.slice(0, at) : token
    if (pseudo.has(path)) return undefined
    const module = local.get(path)
    if (module) return builder.node(moduleNode(module))
    if (at <= 0) return builder.node({ id: path, name: path, ecosystem: 'Go', kind: 'workspace' })
    const version = token.slice(at + 1)
    versions.set(path, (versions.get(path) ?? new Set()).add(version))
    return builder.node({ id: token, name: path, version, ecosystem: 'Go', kind: 'package' })
  }

  for (const line of output.split(/\r?\n/)) {
    const [from, to] = line.trim().split(/\s+/)
    if (!from || !to) continue
    const fromId = nodeId(from)
    const toId = nodeId(to)
    if (fromId !== undefined && toId !== undefined && fromId !== toId)
      builder.edge(fromId, toId, 'prod')
  }

  const graph = builder.build()
  const selected = new Map(
    [...versions].map(([path, set]) => [path, [...set].toSorted(compareVersions).at(-1)]),
  )
  return {
    nodes: graph.nodes.map((node) =>
      node.kind === 'package'
        ? { ...node, selected: selected.get(node.name) === node.version }
        : node,
    ),
    edges: graph.edges,
  }
}
