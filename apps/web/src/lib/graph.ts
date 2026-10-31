import { graphlib, layout } from '@dagrejs/dagre'
import type { GraphEdge, GraphNode } from '@holtkeeper/api'

/** Edge key used to look up highlighted edges. */
export const edgeKey = (from: string, to: string): string => `${from}\u0000${to}`

/**
 * Nodes and edges on the highlighted paths. A path is a list of node ids; consecutive ids are
 * edges, and a path whose last node links back to its first (a cycle) includes that edge too.
 */
export function highlighted(
  paths: readonly (readonly string[])[] | undefined,
  edges: readonly GraphEdge[],
): { nodes: Set<string>; edges: Set<string> } {
  const existing = new Set(edges.map((edge) => edgeKey(edge.from, edge.to)))
  const nodeSet = new Set<string>()
  const edgeSet = new Set<string>()
  for (const path of paths ?? []) {
    for (const id of path) nodeSet.add(id)
    for (let i = 0; i + 1 < path.length; i++) edgeSet.add(edgeKey(path[i]!, path[i + 1]!))
    const first = path[0]
    const last = path.at(-1)
    if (
      first !== undefined &&
      last !== undefined &&
      first !== last &&
      existing.has(edgeKey(last, first))
    ) {
      edgeSet.add(edgeKey(last, first))
    }
  }
  return { nodes: nodeSet, edges: edgeSet }
}

/**
 * Keeps at most `limit` nodes: highlighted ones first, then the most connected. Edges survive
 * only between kept nodes. `dropped` says how many nodes were left out.
 */
export function capGraph(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  limit: number,
  keep: ReadonlySet<string> = new Set(),
): { nodes: GraphNode[]; edges: GraphEdge[]; dropped: number } {
  if (nodes.length <= limit) return { nodes: [...nodes], edges: [...edges], dropped: 0 }
  const degree = new Map<string, number>()
  for (const edge of edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1)
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1)
  }
  const ranked = nodes.toSorted(
    (a, b) =>
      Number(keep.has(b.id)) - Number(keep.has(a.id)) ||
      (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) ||
      (b.size ?? 0) - (a.size ?? 0),
  )
  const kept = ranked.slice(0, limit)
  const ids = new Set(kept.map((node) => node.id))
  return {
    nodes: kept,
    edges: edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)),
    dropped: nodes.length - kept.length,
  }
}

/** Node box size from its relative `size`: between `min` and `max` width, area-proportional. */
export function nodeWidth(size: number | undefined, maxSize: number, min = 120, max = 220): number {
  if (!size || maxSize <= 0) return min
  return Math.round(min + (max - min) * Math.sqrt(Math.min(size, maxSize) / maxSize))
}

export interface Positioned {
  id: string
  x: number
  y: number
  width: number
  height: number
}

/** Top-left positions from a layered (Sugiyama) layout, left to right. Ignores unknown edge ends. */
export function layeredLayout(
  nodes: readonly { id: string; width: number; height: number }[],
  edges: readonly { from: string; to: string }[],
): Positioned[] {
  const graph = new graphlib.Graph()
  graph.setGraph({ rankdir: 'LR', nodesep: 24, ranksep: 72, marginx: 8, marginy: 8 })
  graph.setDefaultEdgeLabel(() => ({}))
  const ids = new Set(nodes.map((node) => node.id))
  for (const node of nodes) graph.setNode(node.id, { width: node.width, height: node.height })
  for (const edge of edges) {
    if (ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to)
      graph.setEdge(edge.from, edge.to)
  }
  layout(graph)
  return nodes.map((node) => {
    const placed: { x?: number; y?: number } = graph.node(node.id) ?? {}
    return {
      ...node,
      x: (placed.x ?? 0) - node.width / 2,
      y: (placed.y ?? 0) - node.height / 2,
    }
  })
}

/**
 * Stand-in for a force layout: each group is a grid of non-overlapping boxes, taller than wide,
 * groups side by side and centered on each other. Stable and cheap.
 */
export function groupedLayout(
  nodes: readonly { id: string; width: number; height: number; group?: string | undefined }[],
  gap = { x: 48, y: 20, group: 200 },
): Positioned[] {
  const groups = Map.groupBy(nodes, (node) => node.group ?? '')
  const blocks = [...groups.values()].map((members) => {
    const rows = Math.ceil(Math.sqrt(members.length * 3))
    const cellWidth = Math.max(...members.map((node) => node.width)) + gap.x
    const cellHeight = Math.max(...members.map((node) => node.height)) + gap.y
    return {
      members,
      rows,
      cellWidth,
      cellHeight,
      width: Math.ceil(members.length / rows) * cellWidth - gap.x,
      height: Math.min(rows, members.length) * cellHeight - gap.y,
    }
  })
  const tallest = Math.max(0, ...blocks.map((block) => block.height))
  const placed: Positioned[] = []
  let offsetX = 0
  for (const block of blocks) {
    const top = (tallest - block.height) / 2
    block.members.forEach((node, index) => {
      placed.push({
        id: node.id,
        width: node.width,
        height: node.height,
        x: offsetX + Math.floor(index / block.rows) * block.cellWidth,
        y: top + (index % block.rows) * block.cellHeight,
      })
    })
    offsetX += block.width + gap.group
  }
  return placed
}
