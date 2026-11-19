import { expect, test } from 'bun:test'

import {
  analyticsPhases,
  concedeShare,
  dayAcceptance,
  dayTotal,
  phaseInfo,
  replyCount,
  reviewSpend,
  share,
} from './review-analytics.ts'

test('every phase has its own label and tone', () => {
  expect(new Set(analyticsPhases.map((phase) => phaseInfo[phase].label)).size).toBe(5)
  expect(new Set(analyticsPhases.map((phase) => phaseInfo[phase].tone)).size).toBe(5)
})

test('sums days, spend and replies', () => {
  expect(dayTotal({ day: '2026-11-02', phases: { initial: 1.5, reply: 0.25 } })).toBe(1.75)
  expect(dayTotal({ day: '2026-11-02', phases: {} })).toBe(0)
  expect(
    reviewSpend({
      phases: [
        { phase: 'initial', costUsd: 2, runs: 1 },
        { phase: 'other', costUsd: 0.5, runs: 3 },
      ],
    }),
  ).toBe(2.5)
  expect(replyCount({ explain: 1, concede: 2, update: 3, fixed: 5, open: 6, unknown: 4 })).toBe(21)
})

test('share is undefined over nothing', () => {
  expect(share(1, 4)).toBe(0.25)
  expect(share(0, 0)).toBeUndefined()
})

test('acceptance of a day and the share of answers that agreed with the person', () => {
  const day = {
    day: '2026-11-02',
    costUsd: 1,
    posted: 3,
    judged: 5,
    fixed: 2,
    resolved: 1,
    ignored: 1,
  }
  expect(dayAcceptance(day)).toBe(0.5)
  expect(dayAcceptance({ ...day, fixed: 0, resolved: 0, ignored: 0 })).toBeUndefined()
  expect(concedeShare({ explain: 2, concede: 1, update: 0, fixed: 1, open: 0, unknown: 7 })).toBe(
    0.25,
  )
  expect(
    concedeShare({ explain: 0, concede: 0, update: 0, fixed: 0, open: 0, unknown: 3 }),
  ).toBeUndefined()
})
