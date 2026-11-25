import { describe, expect, test } from 'bun:test'

import { BudgetExceededError, isBudgetStop } from './errors.ts'
import { settledInParallel } from './parallel.ts'

describe('settledInParallel', () => {
  test('settles every item in order and never runs more than the limit at once', async () => {
    let running = 0
    let peak = 0
    const results = await settledInParallel([1, 2, 3, 4, 5], 2, undefined, async (item) => {
      running++
      peak = Math.max(peak, running)
      await Bun.sleep(1)
      running--
      if (item === 3) throw new Error('three')
      return item * 10
    })
    expect(peak).toBe(2)
    expect(results.map((result) => result.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'rejected',
      'fulfilled',
      'fulfilled',
    ])
    expect(results[4]).toEqual({ status: 'fulfilled', value: 50 })
  })

  test('rejects once the signal aborts', async () => {
    const controller = new AbortController()
    const run = settledInParallel([1, 2, 3], 1, controller.signal, async () => {
      controller.abort(new Error('stop'))
    })
    expect(run).rejects.toThrow('stop')
  })
})

describe('isBudgetStop', () => {
  test('finds a budget error in the cause chain', () => {
    const budget = new BudgetExceededError('used up')
    expect(isBudgetStop(new Error('outer', { cause: budget }))).toBe(true)
    expect(isBudgetStop(new Error('other'))).toBe(false)
    const loop = new Error('loop')
    loop.cause = loop
    expect(isBudgetStop(loop)).toBe(false)
  })
})
