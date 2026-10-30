import type { DepEdge, DepEdgeKind, DepGraph, DepNode } from './model.ts'

/** Adjacency lists of a graph, built once per analysis. */
export interface GraphIndex {
  nodes: Map<string, DepNode>
  out: Map<string, string[]>
  in: Map<string, string[]>
}

export function indexGraph(graph: DepGraph): GraphIndex {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]))
  const out = new Map<string, string[]>()
  const into = new Map<string, string[]>()
  for (const node of graph.nodes) {
    out.set(node.id, [])
    into.set(node.id, [])
  }
  for (const edge of graph.edges) {
    out.get(edge.from)?.push(edge.to)
    into.get(edge.to)?.push(edge.from)
  }
  return { nodes, out, in: into }
}

/** Nodes paths start from: workspaces, or nodes nothing depends on when there are none. */
export function rootIds(index: GraphIndex): string[] {
  const workspaces = [...index.nodes.values()].filter((node) => node.kind === 'workspace')
  if (workspaces.length > 0) return workspaces.map((node) => node.id).toSorted()
  return [...index.nodes.keys()].filter((id) => index.in.get(id)?.length === 0).toSorted()
}

/** Multi-source breadth-first search: the parent of every reachable node and its distance. */
export function bfs(index: GraphIndex, sources: readonly string[]) {
  const parent = new Map<string, string | undefined>()
  const depth = new Map<string, number>()
  const queue: string[] = []
  for (const id of sources) {
    if (!index.nodes.has(id) || parent.has(id)) continue
    parent.set(id, undefined)
    depth.set(id, 0)
    queue.push(id)
  }
  for (const id of queue) {
    const next = (depth.get(id) ?? 0) + 1
    for (const to of index.out.get(id) ?? []) {
      if (parent.has(to)) continue
      parent.set(to, id)
      depth.set(to, next)
      queue.push(to)
    }
  }
  return { parent, depth }
}

/** The path from a search source to `id` following `parent`, or `[]` when `id` was not reached. */
export function pathTo(parent: Map<string, string | undefined>, id: string): string[] {
  if (!parent.has(id)) return []
  const path: string[] = []
  let current: string | undefined = id
  while (current !== undefined) {
    path.push(current)
    current = parent.get(current)
  }
  return path.toReversed()
}

/**
 * Collects nodes and edges without duplicates. The first edge between two nodes wins, except that
 * a `prod` edge replaces any other kind.
 */
export class GraphBuilder {
  readonly #nodes = new Map<string, DepNode>()
  readonly #edges = new Map<string, DepEdge>()

  has(id: string): boolean {
    return this.#nodes.has(id)
  }

  node(node: DepNode): string {
    if (!this.#nodes.has(node.id)) this.#nodes.set(node.id, node)
    return node.id
  }

  edge(from: string, to: string, kind: DepEdgeKind): void {
    const key = `${from}\0${to}`
    const existing = this.#edges.get(key)
    if (!existing || (kind === 'prod' && existing.kind !== 'prod'))
      this.#edges.set(key, { from, to, kind })
  }

  build(): DepGraph {
    const edges = [...this.#edges.values()].filter(
      (edge) => this.#nodes.has(edge.from) && this.#nodes.has(edge.to),
    )
    return { nodes: [...this.#nodes.values()], edges }
  }
}
