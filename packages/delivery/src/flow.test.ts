import { expect, test } from 'bun:test'

import { at, mr } from '../test/history.ts'
import { computeFlow } from './flow.ts'

test('open merge requests by age, stale ones and time to merge', () => {
  const mergeRequests = [
    mr({ id: 1, createdAt: at(27, 12), state: 'open', updatedAt: at(27, 12) }),
    mr({ id: 2, createdAt: at(10), state: 'open', updatedAt: at(25) }),
    mr({ id: 3, createdAt: at(-30), state: 'open', updatedAt: at(5), draft: true, labels: ['x'] }),
    mr({ id: 4, createdAt: at(15), state: 'open', updatedAt: at(18) }),
    mr({ id: 5, createdAt: at(1), mergedAt: at(1, 0.5), changesCount: 3 }),
    mr({ id: 6, createdAt: at(2), mergedAt: at(2, 5), changesCount: 7 }),
    mr({ id: 7, createdAt: at(3), mergedAt: at(13), changesCount: 40 }),
    mr({ id: 8, createdAt: at(-20), mergedAt: at(-10) }),
    mr({ id: 9, createdAt: at(3), state: 'closed', closedAt: at(4) }),
  ]
  const flow = computeFlow({ from: at(0), to: at(28), mergeRequests, staleDays: 7 })
  expect(flow.open).toBe(4)
  expect(flow.drafts).toBe(1)
  expect(flow.openByAge).toEqual([
    { label: '< 1 day', count: 1 },
    { label: '1–7 days', count: 0 },
    { label: '7–30 days', count: 2 },
    { label: '> 30 days', count: 1 },
  ])
  expect(flow.stale.map((s) => [s.id, s.idleDays, s.ageDays])).toEqual([
    [3, 23, 58],
    [4, 10, 13],
  ])
  expect(flow.merged).toBe(3)
  expect(flow.timeToMerge.median).toBe(5 * 3600)
  expect(flow.timeToMerge.buckets.map((b) => b.count)).toEqual([1, 1, 0, 1])
  expect(flow.size?.median).toBe(7)
})

test('no size when the forge does not report it', () => {
  const flow = computeFlow({
    from: at(0),
    to: at(28),
    mergeRequests: [mr({ createdAt: at(1), mergedAt: at(2) })],
    staleDays: 7,
  })
  expect(flow.size).toBeUndefined()
  expect(flow.stale).toEqual([])
})
