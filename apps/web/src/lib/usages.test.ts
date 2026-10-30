import { describe, expect, test } from 'bun:test'

import { kindCounts, memberLabel, relativeCounts, snippetLines } from './usages.ts'

describe('usage helpers', () => {
  test('labels members after the export', () => {
    expect(memberLabel('reset')).toBe('.reset')
    expect(memberLabel('().reset')).toBe('().reset')
  })

  test('numbers snippet lines and marks the used one', () => {
    expect(snippetLines({ snippet: 'a\nb\nc', snippetLine: 7, line: 8 })).toEqual([
      { number: 7, text: 'a', focus: false },
      { number: 8, text: 'b', focus: true },
      { number: 9, text: 'c', focus: false },
    ])
  })

  test('orders kinds and scales counts to the largest', () => {
    expect(kindCounts({ type: 1, jsx: 4 })).toEqual([
      { kind: 'jsx', count: 4 },
      { kind: 'type', count: 1 },
    ])
    expect(
      relativeCounts([
        { name: 'a', count: 4 },
        { name: 'b', count: 1 },
      ]),
    ).toEqual([
      { name: 'a', count: 4, share: 100 },
      { name: 'b', count: 1, share: 25 },
    ])
  })
})
