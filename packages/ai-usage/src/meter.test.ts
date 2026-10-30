import { describe, expect, test } from 'bun:test'

import type { Agent, AgentResult } from '@holtkeeper/agent'
import type { AiUsageRecord } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'

import { budgetGuard } from './budget.ts'
import { computeCost, costOf, defaultPrices, priceFor } from './cost.ts'
import { BudgetExceededError, meteredAgent, usageRecorder } from './meter.ts'

const repo = { forge: 'work', path: 'games/slots', groups: ['games'] }

const fakeAgent = (outcome: AgentResult | Error, onRun = () => {}): Agent => ({
  name: 'fake',
  async run() {
    onRun()
    if (outcome instanceof Error) throw outcome
    return outcome as never
  },
})

const fixedNow = () => new Date('2026-10-30T10:00:00.000Z')

const clock = (...times: string[]) => {
  let index = 0
  return () => new Date(times[Math.min(index++, times.length - 1)] ?? 0)
}

describe('costs', () => {
  test('reported cost wins, otherwise computed from the price table', () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 0,
    }
    expect(costOf({ costUsd: 1.5, usage }, 'claude-opus-5-5')).toEqual({
      costUsd: 1.5,
      costSource: 'reported',
    })
    expect(costOf({ usage }, 'claude-opus-5-5').costSource).toBe('computed')
    expect(costOf({ usage }, 'claude-opus-5-5').costUsd).toBeCloseTo(4 + 2 + 0.2)
    expect(costOf({ usage }, 'mystery')).toEqual({ costUsd: 0, costSource: 'unknown' })
    expect(costOf({}, 'claude-opus-5-5')).toEqual({ costUsd: 0, costSource: 'unknown' })
    expect(priceFor('anthropic.claude-sonnet-5-5')).toBe(defaultPrices['claude-sonnet-5-5'])
    expect(priceFor('claude-opus-5-5[1m]')).toBe(defaultPrices['claude-opus-5-5'])
    expect(
      computeCost(
        { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1_000_000 },
        { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
      ),
    ).toBe(5)
  })
})

describe('meteredAgent', () => {
  const context = { repo, actor: 'jane', provider: 'cred-1', model: 'claude-opus-5-5', jobId: 'j1' }

  test('records a successful run and passes the result through', async () => {
    const records: Omit<AiUsageRecord, 'id'>[] = []
    const result: AgentResult = {
      text: 'done',
      turns: 3,
      costUsd: 0.42,
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 1 },
    }
    const agent = meteredAgent(fakeAgent(result), {
      record: (e) => void records.push(e),
      context,
      now: clock('2026-10-30T10:00:00.000Z', '2026-10-30T10:00:02.500Z'),
    })
    expect(await agent.run({ dir: '/x', prompt: 'p', taskKind: 'review' })).toBe(result)
    expect(records).toEqual([
      {
        at: '2026-10-30T10:00:00.000Z',
        repo: { forge: 'work', path: 'games/slots' },
        groups: ['games'],
        taskKind: 'review',
        jobId: 'j1',
        actor: 'jane',
        provider: 'cred-1',
        model: 'claude-opus-5-5',
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 100,
        cacheWriteTokens: 1,
        costUsd: 0.42,
        costSource: 'reported',
        durationMs: 2500,
        turns: 3,
        outcome: 'ok',
      },
    ])
  })

  test('records failures with partial usage and rethrows', async () => {
    const records: Omit<AiUsageRecord, 'id'>[] = []
    const failure = Object.assign(new Error('max turns'), {
      turns: 7,
      usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
    const agent = meteredAgent(fakeAgent(failure), {
      record: (e) => void records.push(e),
      context,
      now: clock('2026-10-30T10:00:00.000Z', '2026-10-30T10:00:01.000Z'),
    })
    expect(agent.run({ dir: '/x', prompt: 'p' })).rejects.toBe(failure)
    await Bun.sleep(0)
    expect(records[0]).toMatchObject({
      taskKind: 'agent',
      outcome: 'error',
      error: 'max turns',
      turns: 7,
      inputTokens: 1_000_000,
      costUsd: 4,
      costSource: 'computed',
      durationMs: 1000,
    })
  })

  test('a block budget denies without running and records denied-budget', async () => {
    const store = memoryStore()
    await store.settings.put({
      id: 'b',
      key: 'llm.budget',
      scope: { all: true },
      value: { monthlyUsd: 1, action: 'block' },
      secret: false,
      updatedAt: '2026-10-01T00:00:00.000Z',
    })
    const budgets = budgetGuard({ settings: store.settings, usage: store.aiUsage, now: fixedNow })
    let ran = 0
    const agent = meteredAgent(
      fakeAgent({ text: '', turns: 1, costUsd: 1 }, () => {
        ran += 1
      }),
      { record: (e) => store.aiUsage.append(e), budgets, context, now: fixedNow },
    )
    await agent.run({ dir: '/x', prompt: 'p' })
    const denied = await agent.run({ dir: '/x', prompt: 'p' }).catch((error: unknown) => error)
    expect(denied).toBeInstanceOf(BudgetExceededError)
    expect((denied as BudgetExceededError).exceeded[0]).toMatchObject({
      budgetId: 'b',
      spentUsd: 1,
    })
    expect(ran).toBe(1)
    expect((await store.aiUsage.list()).map((r) => [r.outcome, r.costUsd])).toEqual([
      ['denied-budget', 0],
      ['ok', 1],
    ])
  })

  test('a failing record does not replace the result', async () => {
    const seen: unknown[] = []
    const agent = meteredAgent(fakeAgent({ text: 'ok', turns: 1 }), {
      record: () => Promise.reject(new Error('disk full')),
      context,
      onRecordError: (error) => seen.push(error),
    })
    expect((await agent.run({ dir: '/x', prompt: 'p' })).text).toBe('ok')
    expect(seen.length).toBe(1)
  })
})

describe('usageRecorder', () => {
  test('stores onRun reports, including errors and budget denials', async () => {
    const store = memoryStore()
    const record = usageRecorder(store.aiUsage, {
      now: () => new Date('2026-10-30T10:00:10.000Z'),
      groupsOf: () => ['games'],
    })
    await record({
      repo: { forge: 'work', path: 'games/slots' },
      taskKind: 'review',
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      result: {
        turns: 2,
        usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
      durationMs: 10_000,
    })
    await record({
      repo: { forge: 'work', path: 'games/slots', groups: ['other'] },
      taskKind: 'review',
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      error: new BudgetExceededError([]),
      durationMs: 0,
      actor: 'jane',
      at: '2026-10-30T11:00:00.000Z',
    })
    const [denied, ok] = await store.aiUsage.list()
    expect(ok).toMatchObject({
      at: '2026-10-30T10:00:00.000Z',
      groups: ['games'],
      actor: 'system',
      costUsd: 2,
      costSource: 'computed',
      outcome: 'ok',
    })
    expect(denied).toMatchObject({ groups: ['other'], actor: 'jane', outcome: 'denied-budget' })
  })
})
