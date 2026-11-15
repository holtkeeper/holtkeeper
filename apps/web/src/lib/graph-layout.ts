/** An edge of a graph to lay out; `weight` (0–1) pulls its ends closer when larger. */
export interface LayoutEdge {
  from: string
  to: string
  weight?: number
}

/** What `layoutGraph` needs besides nodes and edges. */
export interface LayoutOptions {
  width: number
  height: number
  /** Simulation steps; more is calmer, 150–300 suits a few hundred nodes. */
  iterations?: number
  /** Changes the starting positions; the same seed always gives the same layout. */
  seed?: number
}

/** A position inside the layout box. */
export interface Point {
  x: number
  y: number
}

const PADDING = 16

/** Small deterministic generator (mulberry32), so layouts do not flicker between renders. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Positions for the node ids of a graph by a small force simulation: nodes repel each other,
 * edges act as springs (stronger weight, shorter spring) and everything is drawn to the centre.
 * Pure and deterministic: the same ids, edges and options give the same positions, every point
 * lies inside the box with a small margin. Edges naming unknown ids are ignored.
 */
export function layoutGraph(
  ids: readonly string[],
  edges: readonly LayoutEdge[],
  options: LayoutOptions,
): Map<string, Point> {
  const { width, height, iterations = 200, seed = 1 } = options
  const result = new Map<string, Point>()
  const n = ids.length
  if (n === 0) return result
  const cx = width / 2
  const cy = height / 2
  if (n === 1) return result.set(ids[0]!, { x: cx, y: cy })

  const next = random(seed)
  const radius = Math.min(width, height) / 3
  const xs: number[] = []
  const ys: number[] = []
  ids.forEach((_, i) => {
    const angle = (i / n) * Math.PI * 2 + next() * 0.5
    xs.push(cx + Math.cos(angle) * radius * (0.6 + next() * 0.4))
    ys.push(cy + Math.sin(angle) * radius * (0.6 + next() * 0.4))
  })

  const index = new Map(ids.map((id, i) => [id, i]))
  const springs = edges.flatMap((edge) => {
    const a = index.get(edge.from)
    const b = index.get(edge.to)
    return a === undefined || b === undefined || a === b
      ? []
      : [{ a, b, weight: Math.min(1, Math.max(0, edge.weight ?? 0.5)) }]
  })

  // Ideal spacing grows with the area per node.
  const ideal = Math.sqrt((width * height) / n) * 0.8
  let temperature = Math.min(width, height) / 8
  const cooling = temperature / (iterations + 1)

  for (let step = 0; step < iterations; step++) {
    const dx = Array.from<number>({ length: n }).fill(0)
    const dy = Array.from<number>({ length: n }).fill(0)
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        let vx = xs[i]! - xs[j]!
        let vy = ys[i]! - ys[j]!
        let distance = Math.hypot(vx, vy)
        if (distance < 0.01) {
          vx = next() - 0.5
          vy = next() - 0.5
          distance = Math.max(0.01, Math.hypot(vx, vy))
        }
        const push = (ideal * ideal) / distance
        dx[i]! += (vx / distance) * push
        dy[i]! += (vy / distance) * push
        dx[j]! -= (vx / distance) * push
        dy[j]! -= (vy / distance) * push
      }
    for (const { a, b, weight } of springs) {
      const vx = xs[a]! - xs[b]!
      const vy = ys[a]! - ys[b]!
      const distance = Math.max(0.01, Math.hypot(vx, vy))
      const pull = ((distance * distance) / ideal) * (0.5 + weight)
      dx[a]! -= (vx / distance) * pull
      dy[a]! -= (vy / distance) * pull
      dx[b]! += (vx / distance) * pull
      dy[b]! += (vy / distance) * pull
    }
    for (let i = 0; i < n; i++) {
      // Gravity keeps unconnected components from drifting to the walls.
      dx[i]! += (cx - xs[i]!) * 0.15
      dy[i]! += (cy - ys[i]!) * 0.15
      const length = Math.max(0.01, Math.hypot(dx[i]!, dy[i]!))
      const move = Math.min(length, temperature)
      xs[i] = Math.min(width - PADDING, Math.max(PADDING, xs[i]! + (dx[i]! / length) * move))
      ys[i] = Math.min(height - PADDING, Math.max(PADDING, ys[i]! + (dy[i]! / length) * move))
    }
    temperature -= cooling
  }

  ids.forEach((id, i) => result.set(id, { x: xs[i]!, y: ys[i]! }))
  return result
}
