import { describe, expect, test } from 'bun:test'

import { sparkPaths } from './sparkline.ts'

describe('sparkPaths', () => {
  test('scales from zero to the largest value', () => {
    expect(sparkPaths([0, 10], 12, 12, 1)).toEqual({
      line: 'M1 11 L11 1',
      area: 'M1 11 L11 1 L11 11 L1 11 Z',
      last: { x: 11, y: 1 },
    })
  })

  test('null values break the line; lone points draw no segment', () => {
    const paths = sparkPaths([5, 5, null, 5], 32, 10, 2)
    expect(paths.line).toBe('M2 2 L11.3 2')
    expect(paths.last).toEqual({ x: 30, y: 2 })
  })

  test('nothing to draw without values', () => {
    expect(sparkPaths([null, null], 10, 10)).toEqual({ line: '', area: '' })
  })
})
