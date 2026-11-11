import { expect, test } from 'bun:test'

import { neighbours, placeFlow } from './flow.ts'

test('places a chain left to right and ignores edges to unknown nodes', () => {
  const nodes = [
    { id: 'a', kind: 'step', data: {} },
    { id: 'b', kind: 'step', data: {}, width: 120, height: 40 },
    { id: 'c', kind: 'step', data: {} },
  ]
  const { placed, width, height } = placeFlow(nodes, [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
    { from: 'c', to: 'gone' },
  ])
  expect(placed.map((box) => box.node.id)).toEqual(['a', 'b', 'c'])
  const [a, b, c] = placed
  expect(a!.x).toBeLessThan(b!.x)
  expect(b!.x).toBeLessThan(c!.x)
  expect([b!.width, b!.height]).toEqual([120, 40])
  expect([a!.width, a!.height]).toEqual([200, 60])
  expect(width).toBe(c!.x + c!.width)
  expect(height).toBeGreaterThanOrEqual(60)
})

test('an empty graph has no size', () => {
  expect(placeFlow([], [])).toEqual({ placed: [], width: 0, height: 0 })
})

test('finds the neighbours of a node for J and K', () => {
  expect(neighbours(['a', 'b', 'c'], 'b')).toEqual({ index: 1, previous: 'a', next: 'c' })
  expect(neighbours(['a', 'b'], 'a')).toEqual({ index: 0, next: 'b' })
  expect(neighbours(['a'], 'x')).toEqual({ index: -1 })
  expect(neighbours(['a'], undefined)).toEqual({ index: -1 })
})
