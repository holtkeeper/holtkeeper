import { indexGraph } from './graph.ts'
import type { GraphIndex } from './graph.ts'
import type { DepGraph } from './model.ts'

/** A strongly connected group of nodes, i.e. nodes that all (transitively) depend on each other. */
export interface Cycle {
  /** Every node of the group, sorted. */
  members: string[]
  /** One shortest cycle through the group, closed: the first id is repeated at the end. */
  path: string[]
}

/** Members above which the shortest cycle is searched from the first member only. */
const exhaustiveLimit = 300

/**
 * Finds every dependency cycle: one entry per strongly connected component with more than one
 * node or a self-loop. Deterministic for a given graph: cycles are sorted by their first member.
 */
export function findCycles(graph: DepGraph): Cycle[] {
  const index = indexGraph(graph)
  const cycles: Cycle[] = []
  for (const component of stronglyConnected(index)) {
    const [only] = component
    const selfLoop =
      component.length === 1 && only !== undefined && index.out.get(only)?.includes(only)
    if (component.length < 2 && !selfLoop) continue
    const members = component.toSorted()
    cycles.push({ members, path: shortestCycle(index, members) })
  }
  return cycles.toSorted((a, b) => (a.members[0] ?? '').localeCompare(b.members[0] ?? ''))
}

/** Tarjan's algorithm without recursion, so deep graphs do not overflow the stack. */
function stronglyConnected(index: GraphIndex): string[][] {
  const order = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const components: string[][] = []
  let counter = 0

  for (const start of index.nodes.keys()) {
    if (order.has(start)) continue
    const work: { id: string; next: number }[] = [{ id: start, next: 0 }]
    order.set(start, counter)
    low.set(start, counter++)
    stack.push(start)
    onStack.add(start)

    for (let frame = work.at(-1); frame; frame = work.at(-1)) {
      const targets = index.out.get(frame.id) ?? []
      const to = targets[frame.next]
      if (to !== undefined) {
        frame.next++
        if (!order.has(to)) {
          order.set(to, counter)
          low.set(to, counter++)
          stack.push(to)
          onStack.add(to)
          work.push({ id: to, next: 0 })
        } else if (onStack.has(to)) {
          low.set(frame.id, Math.min(low.get(frame.id) ?? 0, order.get(to) ?? 0))
        }
        continue
      }
      work.pop()
      const parent = work[work.length - 1]
      if (parent) low.set(parent.id, Math.min(low.get(parent.id) ?? 0, low.get(frame.id) ?? 0))
      if (low.get(frame.id) !== order.get(frame.id)) continue
      const component: string[] = []
      for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
        onStack.delete(id)
        component.push(id)
        if (id === frame.id) break
      }
      components.push(component)
    }
  }
  return components
}

function shortestCycle(index: GraphIndex, members: string[]): string[] {
  const inside = new Set(members)
  const starts = members.length > exhaustiveLimit ? members.slice(0, 1) : members
  let best: string[] = []
  for (const start of starts) {
    const path = cycleThrough(index, inside, start, best.length === 0 ? Infinity : best.length - 1)
    if (path && (best.length === 0 || path.length < best.length)) best = path
    if (best.length === 2) break
  }
  return best
}

/** Shortest cycle through `start` staying inside the component, if shorter than `limit` edges. */
function cycleThrough(
  index: GraphIndex,
  inside: Set<string>,
  start: string,
  limit: number,
): string[] | undefined {
  const parent = new Map<string, string>()
  const depth = new Map<string, number>([[start, 0]])
  const queue = [start]
  for (const id of queue) {
    const next = (depth.get(id) ?? 0) + 1
    if (next > limit) return undefined
    for (const to of index.out.get(id) ?? []) {
      if (!inside.has(to)) continue
      if (to === start) {
        const path = [start]
        for (
          let current: string | undefined = id;
          current !== undefined && current !== start;
          current = parent.get(current)
        )
          path.unshift(current)
        return [start, ...path.slice(0, -1), start]
      }
      if (depth.has(to)) continue
      depth.set(to, next)
      parent.set(to, id)
      queue.push(to)
    }
  }
  return undefined
}
