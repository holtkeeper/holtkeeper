import { expect, test } from 'bun:test'

import { emptySeverities } from '@holtkeeper/api'

import {
  addCounts,
  compareCounts,
  severityRank,
  severityTone,
  totalOf,
  worstSeverity,
} from './severity.ts'

test('severity helpers', () => {
  const a = { ...emptySeverities(), high: 2, low: 1 }
  const b = { ...emptySeverities(), critical: 1 }
  expect(severityRank('critical')).toBe(0)
  expect(severityRank('unknown')).toBe(4)
  expect(worstSeverity(a)).toBe('high')
  expect(worstSeverity(emptySeverities())).toBeUndefined()
  expect(totalOf(addCounts(a, b))).toBe(4)
  expect([a, b].toSorted(compareCounts)).toEqual([b, a])
})

test('severityTone', () => {
  expect(
    ['critical', 'high', 'medium', 'low', 'unknown'].map((s) => severityTone(s as never)),
  ).toEqual(['danger', 'danger', 'warning', 'info', 'default'])
})
