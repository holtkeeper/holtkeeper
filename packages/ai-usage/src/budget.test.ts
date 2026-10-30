import { describe, expect, test } from 'bun:test'

import type { RepoTarget, Scope } from '@holtkeeper/access'
import type { AiUsageRecord, SettingEntry, Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'

import { applicableBudgets, budgetGuard, budgetStatuses, parseBudgets } from './budget.ts'
import { periodRange, previousMonth, projectMonthEnd } from './period.ts'

const slots: RepoTarget = { forge: 'work', path: 'games/slots', groups: ['games'] }

const entry = (
  id: string,
  scope: Scope,
  value: unknown,
  updatedAt = '2026-10-01T00:00:00.000Z',
): SettingEntry => ({ id, key: 'llm.budget', scope, value, secret: false, updatedAt })

const spend = (
  at: string,
  costUsd: number,
  overrides: Partial<Omit<AiUsageRecord, 'id'>> = {},
): Omit<AiUsageRecord, 'id'> => ({
  at,
  repo: { forge: slots.forge, path: slots.path },
  groups: slots.groups,
  taskKind: 'review',
  actor: 'system',
  provider: 'anthropic',
  model: 'claude-opus-5-5',
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd,
  costSource: 'reported',
  durationMs: 10,
  turns: 1,
  outcome: 'ok',
  ...overrides,
})

describe('periods', () => {
  test('UTC day and month boundaries', () => {
    const now = new Date('2026-10-31T23:59:59.999Z')
    expect(periodRange('day', now)).toEqual({
      from: '2026-10-31T00:00:00.000Z',
      to: '2026-11-01T00:00:00.000Z',
      key: '2026-10-31',
    })
    expect(periodRange('month', now)).toEqual({
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-11-01T00:00:00.000Z',
      key: '2026-10',
    })
    expect(periodRange('month', new Date('2026-12-15T00:00:00.000Z')).to).toBe(
      '2027-01-01T00:00:00.000Z',
    )
    expect(previousMonth(new Date('2026-01-10T00:00:00.000Z')).key).toBe('2025-12')
  })

  test('projects month-end spend linearly', () => {
    expect(projectMonthEnd(10, new Date('2026-11-16T00:00:00.000Z'))).toBeCloseTo(20)
    expect(projectMonthEnd(5, new Date('2026-11-01T00:00:00.000Z'))).toBe(5)
  })
})

describe('budget resolution', () => {
  test('most specific covering budget plus the global one; invalid values skipped', () => {
    const budgets = parseBudgets([
      entry('global', { all: true }, { monthlyUsd: 100, action: 'warn' }),
      entry('games', { groups: ['games'] }, { monthlyUsd: 50, action: 'block' }),
      entry('glob', { repos: ['work:games/**'] }, { monthlyUsd: 20, action: 'block' }),
      entry('exact', { repos: ['work:games/slots'] }, { dailyUsd: 2, action: 'warn' }),
      entry('broken', { repos: ['work:games/slots'] }, { action: 'explode' }),
      { ...entry('other', { all: true }, { monthlyUsd: 1, action: 'warn' }), key: 'llm.model' },
    ])
    expect(budgets.map((b) => b.id)).toEqual(['global', 'games', 'glob', 'exact'])
    expect(applicableBudgets(budgets, slots).map((b) => b.id)).toEqual(['exact', 'global'])
    expect(
      applicableBudgets(budgets, { forge: 'work', path: 'games/poker', groups: [] }).map(
        (b) => b.id,
      ),
    ).toEqual(['glob', 'global'])
    expect(
      applicableBudgets(budgets, { forge: 'work', path: 'tools/x', groups: [] }).map((b) => b.id),
    ).toEqual(['global'])
    expect(applicableBudgets(budgets.slice(1), { forge: 'w', path: 'x', groups: [] })).toEqual([])
  })

  test('the newest of equally specific budgets wins', () => {
    const budgets = parseBudgets([
      entry(
        'old',
        { groups: ['games'] },
        { monthlyUsd: 1, action: 'warn' },
        '2026-01-01T00:00:00Z',
      ),
      entry(
        'new',
        { groups: ['games'] },
        { monthlyUsd: 2, action: 'warn' },
        '2026-02-01T00:00:00Z',
      ),
    ])
    expect(applicableBudgets(budgets, slots).map((b) => b.id)).toEqual(['new'])
  })
})

const setup = async (entries: SettingEntry[], records: Omit<AiUsageRecord, 'id'>[]) => {
  const store: Store = memoryStore()
  for (const e of entries) await store.settings.put(e)
  for (const r of records) await store.aiUsage.append(r)
  let now = new Date('2026-10-30T12:00:00.000Z')
  const guard = budgetGuard({
    settings: store.settings,
    usage: store.aiUsage,
    activity: store.activity,
    now: () => now,
    cacheMs: 1000,
  })
  return { store, guard, setNow: (value: string) => (now = new Date(value)) }
}

describe('budgetGuard', () => {
  test('block denies once the limit is reached, warn only reports', async () => {
    const { guard, store } = await setup(
      [
        entry('repo', { repos: ['work:games/slots'] }, { monthlyUsd: 10, action: 'block' }),
        entry('global', { all: true }, { dailyUsd: 1, action: 'warn' }),
      ],
      [spend('2026-10-02T00:00:00.000Z', 9), spend('2026-10-30T01:00:00.000Z', 1.5)],
    )
    const decision = await guard.check({ repo: slots, taskKind: 'review' })
    expect(decision.allowed).toBeFalse()
    expect(decision.exceeded.map((s) => [s.budgetId, s.period, s.action, s.spentUsd])).toEqual([
      ['repo', 'month', 'block', 10.5],
      ['global', 'day', 'warn', 1.5],
    ])
    const events = await store.activity.list()
    expect(
      events.map((e) => `${e.action} ${e.subject}`).toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(['ai.budget.exceeded global', 'ai.budget.exceeded repo'])

    const other = await guard.check({
      repo: { forge: 'work', path: 'tools/cli', groups: [] },
      taskKind: 'review',
    })
    expect(other.allowed).toBeTrue()
    expect(other.exceeded.map((s) => s.budgetId)).toEqual(['global'])
  })

  test('the activity event fires once per limit and period', async () => {
    const { guard, store, setNow } = await setup(
      [entry('global', { all: true }, { dailyUsd: 1, action: 'warn' })],
      [spend('2026-10-30T01:00:00.000Z', 2), spend('2026-10-31T01:00:00.000Z', 2)],
    )
    await guard.check({ repo: slots, taskKind: 'review' })
    await guard.check({ repo: slots, taskKind: 'review' })
    expect((await store.activity.list()).length).toBe(1)
    setNow('2026-10-31T12:00:00.000Z')
    expect((await guard.check({ repo: slots, taskKind: 'review' })).exceeded.length).toBe(1)
    expect((await store.activity.list()).length).toBe(2)
  })

  test('periods reset at UTC boundaries', async () => {
    const { guard, setNow } = await setup(
      [entry('global', { all: true }, { monthlyUsd: 5, dailyUsd: 3, action: 'block' })],
      [spend('2026-10-31T23:59:59.999Z', 4), spend('2026-10-15T00:00:00.000Z', 1)],
    )
    setNow('2026-10-31T23:59:59.999Z')
    expect(
      (await guard.check({ repo: slots, taskKind: 'x' })).exceeded.map((s) => s.period),
    ).toEqual(['month', 'day'])
    setNow('2026-11-01T00:00:00.000Z')
    expect(await guard.check({ repo: slots, taskKind: 'x' })).toEqual({
      allowed: true,
      exceeded: [],
    })
  })

  test('per task kind limits count only that task kind', async () => {
    const { guard } = await setup(
      [entry('games', { groups: ['games'] }, { perTaskKind: { review: 2 }, action: 'block' })],
      [
        spend('2026-10-10T00:00:00.000Z', 2),
        spend('2026-10-10T00:00:00.000Z', 5, { taskKind: 'port' }),
      ],
    )
    expect((await guard.check({ repo: slots, taskKind: 'review' })).allowed).toBeFalse()
    expect((await guard.check({ repo: slots, taskKind: 'port' })).allowed).toBeTrue()
  })

  test('cached spend is reused, bumped by note and refreshed after cacheMs', async () => {
    const { guard, store, setNow } = await setup(
      [entry('global', { all: true }, { monthlyUsd: 5, action: 'block' })],
      [spend('2026-10-10T00:00:00.000Z', 4)],
    )
    expect((await guard.check({ repo: slots, taskKind: 'r' })).allowed).toBeTrue()
    await store.aiUsage.append(spend('2026-10-30T12:00:00.000Z', 3))
    expect((await guard.check({ repo: slots, taskKind: 'r' })).allowed).toBeTrue()
    setNow('2026-10-30T12:00:02.000Z')
    expect((await guard.check({ repo: slots, taskKind: 'r' })).allowed).toBeFalse()

    const fresh = await setup(
      [entry('global', { all: true }, { monthlyUsd: 5, action: 'block' })],
      [spend('2026-10-10T00:00:00.000Z', 4)],
    )
    expect((await fresh.guard.check({ repo: slots, taskKind: 'r' })).allowed).toBeTrue()
    fresh.guard.note(spend('2026-10-30T12:00:00.000Z', 1))
    expect((await fresh.guard.check({ repo: slots, taskKind: 'r' })).allowed).toBeFalse()
  })
})

test('budgetStatuses reports spend, percent and projection per limit', async () => {
  const store = memoryStore()
  await store.aiUsage.append(spend('2026-11-02T00:00:00.000Z', 3))
  await store.aiUsage.append(spend('2026-11-16T00:00:00.000Z', 2, { taskKind: 'port' }))
  const [status] = await budgetStatuses(
    [
      entry(
        'g',
        { groups: ['games'] },
        { monthlyUsd: 20, dailyUsd: 4, perTaskKind: { port: 4 }, action: 'warn' },
      ),
    ],
    store.aiUsage,
    new Date('2026-11-16T00:00:00.000Z'),
  )
  expect(status?.limits).toEqual([
    { period: 'month', limitUsd: 20, spentUsd: 5, percent: 25, projectedUsd: 10 },
    { period: 'day', limitUsd: 4, spentUsd: 2, percent: 50 },
    { period: 'month', taskKind: 'port', limitUsd: 4, spentUsd: 2, percent: 50, projectedUsd: 4 },
  ])
})
