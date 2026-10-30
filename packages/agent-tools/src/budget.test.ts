import { describe, expect, test } from 'bun:test'

import { budgetOf, clip, DEFAULT_BUDGET, limitLines, renderBlocks } from './budget.ts'

describe('budget', () => {
  test('overrides only positive values', () => {
    expect(budgetOf({ maxResultLines: 40, maxHits: 0 })).toEqual({
      ...DEFAULT_BUDGET,
      maxResultLines: 40,
    })
  })

  test('clips lines and limits line lists with a marker', () => {
    expect(clip('abcdef', 3)).toBe('abc…')
    expect(clip('abc', 3)).toBe('abc')
    expect(limitLines(['a', 'b', 'c'], 3)).toEqual(['a', 'b', 'c'])
    expect(limitLines(['a', 'b', 'c', 'd'], 3, 'items')).toEqual(['a', 'b', '… 2 more items'])
  })

  test('renders whole blocks within the line and hit limits', () => {
    const blocks = [
      ['a', ' 1'],
      ['b', ' 2'],
      ['c', ' 3'],
    ]
    expect(renderBlocks(blocks, { maxResultLines: 5, maxHits: 10 }, 'hits')).toBe(
      'a\n 1\nb\n 2\n… 1 more hits',
    )
    expect(renderBlocks(blocks, { maxResultLines: 50, maxHits: 1 }, 'hits')).toBe(
      'a\n 1\n… 2 more hits',
    )
    expect(renderBlocks([['x', '1', '2', '3']], { maxResultLines: 3, maxHits: 5 }, 'hits')).toBe(
      'x\n1',
    )
  })
})
