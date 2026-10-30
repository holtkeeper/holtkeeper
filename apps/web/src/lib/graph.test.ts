import { describe, expect, test } from 'bun:test'

import { capGraph, edgeKey, groupedLayout, highlighted, layeredLayout, nodeWidth } from './graph.ts'

const edges = [
  { from: 'a', to: 'b' },
  { from: 'b', to: 'c' },
  { from: 'c', to: 'a' },
  { from: 'c', to: 'd' },
]

describe('highlighted', () => {
  test('marks path edges and the closing edge of a cycle', () => {
    const result = highlighted([['a', 'b', 'c']], edges)
    expect([...result.nodes]).toEqual(['a', 'b', 'c'])
    expect(result.edges.has(edgeKey('a', 'b'))).toBe(true)
    expect(result.edges.has(edgeKey('c', 'a'))).toBe(true)
    expect(result.edges.has(edgeKey('c', 'd'))).toBe(false)
  })

  test('handles no paths', () => {
    expect(highlighted(undefined, edges).nodes.size).toBe(0)
  })
})

describe('capGraph', () => {
  const nodes = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, label: id }))

  test('keeps highlighted then most connected nodes', () => {
    const capped = capGraph(nodes, edges, 2, new Set(['d']))
    expect(capped.nodes.map((n) => n.id)).toEqual(['d', 'c'])
    expect(capped.edges).toEqual([{ from: 'c', to: 'd' }])
    expect(capped.dropped).toBe(3)
  })

  test('leaves small graphs alone', () => {
    expect(capGraph(nodes, edges, 10).dropped).toBe(0)
  })
})

describe('layout', () => {
  test('layered layout orders ranks left to right', () => {
    const box = { width: 100, height: 40 }
    const placed = layeredLayout(
      [
        { id: 'a', ...box },
        { id: 'b', ...box },
        { id: 'c', ...box },
      ],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'x', to: 'a' },
      ],
    )
    const x = Object.fromEntries(placed.map((p) => [p.id, p.x]))
    expect(x.a! < x.b! && x.b! < x.c!).toBe(true)
  })

  test('grouped layout places every node', () => {
    const placed = groupedLayout([
      { id: 'a', width: 100, height: 40, group: 'g' },
      { id: 'b', width: 100, height: 40, group: 'g' },
      { id: 'c', width: 100, height: 40 },
    ])
    expect(placed).toHaveLength(3)
    expect(new Set(placed.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`)).size).toBe(3)
  })

  test('node width grows with size', () => {
    expect(nodeWidth(undefined, 10)).toBe(120)
    expect(nodeWidth(10, 10)).toBe(220)
    expect(nodeWidth(2.5, 10)).toBe(170)
  })
})
