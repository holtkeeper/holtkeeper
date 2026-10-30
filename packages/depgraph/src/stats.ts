import { bfs, indexGraph, pathTo, rootIds } from './graph.ts'
import type { DepGraph, DepNodeKind } from './model.ts'

/** Summary numbers of one graph. */
export interface GraphStats {
  nodes: number
  edges: number
  byKind: Partial<Record<DepNodeKind, number>>
  byEcosystem: Record<string, number>
  /** Non-workspace nodes a workspace depends on directly. */
  direct: number
  /** Non-workspace nodes reachable only through other dependencies. */
  transitive: number
  /** Nodes with the most direct dependents, most first; at most `top` entries. */
  mostDependedOn: { id: string; dependents: number }[]
  /** Shortest path from a workspace (or root) to the node farthest from all of them. */
  deepestChain: string[]
}

/** Counts and rankings of a graph. Pure; `top` limits `mostDependedOn` (default 15). */
export function graphStats(graph: DepGraph, options: { top?: number } = {}): GraphStats {
  const { top = 15 } = options
  const index = indexGraph(graph)
  const byKind: Partial<Record<DepNodeKind, number>> = {}
  const byEcosystem: Record<string, number> = {}
  for (const node of graph.nodes) {
    byKind[node.kind] = (byKind[node.kind] ?? 0) + 1
    byEcosystem[node.ecosystem] = (byEcosystem[node.ecosystem] ?? 0) + 1
  }

  const roots = rootIds(index)
  const rootSet = new Set(roots)
  const isWorkspace = (id: string) => index.nodes.get(id)?.kind === 'workspace'
  const direct = new Set<string>()
  for (const root of roots)
    for (const to of index.out.get(root) ?? []) if (!isWorkspace(to)) direct.add(to)

  const { parent, depth } = bfs(index, roots)
  let transitive = 0
  let deepest: string | undefined
  for (const [id, distance] of depth) {
    if (!isWorkspace(id) && !direct.has(id) && !rootSet.has(id)) transitive++
    if (deepest === undefined || distance > (depth.get(deepest) ?? 0)) deepest = id
  }

  const mostDependedOn = [...index.in]
    .map(([id, from]) => ({ id, dependents: new Set(from).size }))
    .filter((entry) => entry.dependents > 0)
    .toSorted((a, b) => b.dependents - a.dependents || a.id.localeCompare(b.id))
    .slice(0, top)

  return {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    byKind,
    byEcosystem,
    direct: direct.size,
    transitive,
    mostDependedOn,
    deepestChain: deepest === undefined ? [] : pathTo(parent, deepest),
  }
}
