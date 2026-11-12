import { describe, expect, test } from 'bun:test'

import {
  type Freshness,
  compareFreshness,
  freshnessLabel,
  freshnessOf,
  freshnessTone,
} from './freshness.ts'

const now = new Date('2026-11-11T12:00:00.000Z')
const head = 'c'.repeat(40)

describe('freshnessOf', () => {
  test('age first, then the sha against the known head', () => {
    expect(freshnessOf({ createdAt: '2026-10-01T00:00:00.000Z', sha: head }, head, now)).toBe(
      'stale',
    )
    expect(freshnessOf({ createdAt: '2026-11-02T00:00:00.000Z', sha: 'a' }, head, now)).toBe(
      'aging',
    )
    expect(freshnessOf({ createdAt: '2026-11-10T00:00:00.000Z', sha: 'a' }, head, now)).toBe(
      'behind',
    )
    expect(freshnessOf({ createdAt: '2026-11-10T00:00:00.000Z', sha: head }, head, now)).toBe(
      'current',
    )
  })

  test('an unknown sha or head never counts as behind', () => {
    expect(freshnessOf({ createdAt: '2026-11-10T00:00:00.000Z' }, head, now)).toBe('current')
    expect(freshnessOf({ createdAt: '2026-11-10T00:00:00.000Z', sha: 'a' }, undefined, now)).toBe(
      'current',
    )
  })

  test('a failed run wins over age, a missing record is never analysed', () => {
    expect(freshnessOf({ createdAt: '2026-11-10T00:00:00.000Z', failed: true }, head, now)).toBe(
      'failed',
    )
    expect(freshnessOf(undefined, head, now)).toBe('never')
    expect(freshnessOf({}, head, now)).toBe('never')
  })
})

test('every state has a label and a tone, and sorts most worrying first', () => {
  const states: Freshness[] = ['never', 'current', 'behind', 'aging', 'stale', 'failed']
  expect(states.toSorted(compareFreshness)).toEqual([
    'failed',
    'stale',
    'aging',
    'behind',
    'current',
    'never',
  ])
  expect(states.map((state) => freshnessLabel[state])).toEqual([
    'Not analysed',
    'Current',
    'Behind HEAD',
    'Over a week old',
    'Over a month old',
    'Failed',
  ])
  expect(freshnessTone.behind).toBe('info')
  expect(freshnessTone.stale).toBe('danger')
})
