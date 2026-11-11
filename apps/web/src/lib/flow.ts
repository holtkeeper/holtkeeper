import type { StatusTone } from '../ui/colors.ts'
import { layeredLayout } from './graph.ts'

/**
 * A node of a `FlowCanvas` graph. `kind` picks the renderer; `data` is whatever that renderer
 * needs. Nothing here is specific to React Flow, and positions are never part of the model.
 */
export interface FlowNodeSpec<K extends string = string, D = unknown> {
  id: string
  kind: K
  data: D
  width?: number
  height?: number
}

/** A directed link between two nodes, optionally captioned, dashed or colored by a status tone. */
export interface FlowEdgeSpec {
  from: string
  to: string
  label?: string
  dashed?: boolean
  tone?: StatusTone
}

const defaultNodeSize = { width: 200, height: 60 }

/** A node with its top-left position from a left-to-right layered layout. */
export interface PlacedNode<N extends FlowNodeSpec> {
  node: N
  x: number
  y: number
  width: number
  height: number
}

/**
 * Positions for a flow graph, left to right, in the order of `nodes`. Edges whose ends are not in
 * `nodes` are ignored, so a stale edge never breaks the drawing.
 */
export function placeFlow<N extends FlowNodeSpec>(
  nodes: readonly N[],
  edges: readonly FlowEdgeSpec[],
): { placed: PlacedNode<N>[]; width: number; height: number } {
  const sized = nodes.map((node) => ({
    id: node.id,
    width: node.width ?? defaultNodeSize.width,
    height: node.height ?? defaultNodeSize.height,
  }))
  const boxes = new Map(layeredLayout(sized, edges).map((box) => [box.id, box]))
  const placed = nodes.map((node) => {
    const box = boxes.get(node.id)!
    return { node, x: box.x, y: box.y, width: box.width, height: box.height }
  })
  return {
    placed,
    width: Math.max(0, ...placed.map((box) => box.x + box.width)),
    height: Math.max(0, ...placed.map((box) => box.y + box.height)),
  }
}

/** Ids of the nodes before and after `id` in `ids`, for stepping through nodes with J and K. */
export function neighbours(
  ids: readonly string[],
  id: string | undefined,
): { index: number; previous?: string; next?: string } {
  const index = id === undefined ? -1 : ids.indexOf(id)
  if (index < 0) return { index }
  const previous = ids[index - 1]
  const next = ids[index + 1]
  return {
    index,
    ...(previous !== undefined ? { previous } : {}),
    ...(next !== undefined ? { next } : {}),
  }
}
