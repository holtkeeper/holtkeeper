import { expect, test } from 'bun:test'

import { layoutGraph } from './graph-layout.ts'

const box = { width: 400, height: 300 }
const ids = ['a', 'b', 'c', 'd', 'e', 'f']
const edges = [
  { from: 'a', to: 'b', weight: 1 },
  { from: 'b', to: 'c', weight: 1 },
  { from: 'a', to: 'c', weight: 1 },
  { from: 'x', to: 'a' },
]

const distance = (layout: ReturnType<typeof layoutGraph>, a: string, b: string) => {
  const p = layout.get(a)!
  const q = layout.get(b)!
  return Math.hypot(p.x - q.x, p.y - q.y)
}

test('the same input gives the same positions, another seed another layout', () => {
  const first = layoutGraph(ids, edges, box)
  expect([...layoutGraph(ids, edges, box)]).toEqual([...first])
  expect([...layoutGraph(ids, edges, { ...box, seed: 7 })]).not.toEqual([...first])
})

test('every node gets a position inside the box', () => {
  const layout = layoutGraph(ids, edges, box)
  expect([...layout.keys()]).toEqual(ids)
  for (const { x, y } of layout.values()) {
    expect(x).toBeGreaterThanOrEqual(0)
    expect(x).toBeLessThanOrEqual(box.width)
    expect(y).toBeGreaterThanOrEqual(0)
    expect(y).toBeLessThanOrEqual(box.height)
  }
})

test('linked nodes end up closer than unlinked ones', () => {
  const layout = layoutGraph(ids, edges, { ...box, iterations: 300 })
  expect(distance(layout, 'a', 'b')).toBeLessThan(distance(layout, 'a', 'f'))
  expect(distance(layout, 'b', 'c')).toBeLessThan(distance(layout, 'c', 'e'))
})

test('nodes never share a position', () => {
  const layout = layoutGraph(ids, [], box)
  for (const a of ids)
    for (const b of ids) if (a < b) expect(distance(layout, a, b)).toBeGreaterThan(1)
})

test('empty and single node graphs are handled', () => {
  expect(layoutGraph([], edges, box).size).toBe(0)
  expect(layoutGraph(['solo'], [], box).get('solo')).toEqual({ x: 200, y: 150 })
})
