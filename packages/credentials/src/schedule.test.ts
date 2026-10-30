import { expect, test } from 'bun:test'

import { startRotationSchedule } from './schedule.ts'
import type { RotationResult } from './types.ts'

test('runs immediately, then on every interval, until stopped', async () => {
  let runs = 0
  const stop = startRotationSchedule({ rotateDue: async () => (runs++, []) }, { intervalMs: 10 })
  await Bun.sleep(0)
  expect(runs).toBe(1)
  await Bun.sleep(35)
  stop()
  const after = runs
  expect(after).toBeGreaterThanOrEqual(3)
  await Bun.sleep(30)
  expect(runs).toBe(after)
})

test('reports results and swallows failures, including from callbacks', async () => {
  const seen: RotationResult[][] = []
  const errors: unknown[] = []
  let call = 0
  const stop = startRotationSchedule(
    {
      rotateDue: async () => {
        call += 1
        if (call === 2) throw new Error('store down')
        return [{ id: 'a', ok: true }]
      },
    },
    {
      intervalMs: 5,
      onResults: (results) => {
        seen.push(results)
        throw new Error('logger broke')
      },
      onError: (error) => errors.push(error),
    },
  )
  await Bun.sleep(30)
  stop()
  expect(seen.length).toBeGreaterThanOrEqual(2)
  expect(errors).toEqual([new Error('store down')])
})

test('skips a tick while the previous run is still going', async () => {
  let active = 0
  let maxActive = 0
  const stop = startRotationSchedule(
    {
      rotateDue: async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await Bun.sleep(25)
        active -= 1
        return []
      },
    },
    { intervalMs: 5 },
  )
  await Bun.sleep(40)
  stop()
  expect(maxActive).toBe(1)
})
