import { describe, expect, test } from 'bun:test'

import type { RepoTarget, Scope } from '@holtkeeper/access'
import type { NewAiUsageRecord, SettingEntry, Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'

import {
  applicableBudgets,
  broadestBudget,
  budgetGuard,
  budgetSchema,
  budgetStatuses,
  parseBudgets,
} from './budget.ts'
import { automaticStopsAt, spendForecast } from './forecast.ts'
import { monthRange, periodSpans, previousWeek, weekRange } from './period.ts'

const app: RepoTarget = { forge: 'work', path: 'games/app', groups: ['games'] }

const entry = (
  id: string,
  scope: Scope,
  value: unknown,
  updatedAt = '2026-10-01T00:00:00.000Z',
): SettingEntry => ({ id, key: 'llm.budget', scope, value, secret: false, updatedAt })

const spend = (
  at: string,
  costUsd: number,
  overrides: Partial<NewAiUsageRecord> = {},
): NewAiUsageRecord => ({
  at,
  repo: { forge: app.forge, path: app.path },
  groups: app.groups,
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
  test('UTC month boundaries', () => {
    expect(monthRange(new Date('2026-10-31T23:59:59.999Z'))).toEqual({
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-11-01T00:00:00.000Z',
      key: '2026-10',
    })
    expect(monthRange(new Date('2026-12-15T00:00:00.000Z')).to).toBe('2027-01-01T00:00:00.000Z')
  })

  test('weeks start on Monday 00:00 in the given time zone', () => {
    expect(weekRange(new Date('2026-11-11T12:00:00.000Z'), 'UTC')).toEqual({
      from: '2026-11-09T00:00:00.000Z',
      to: '2026-11-16T00:00:00.000Z',
      key: '2026-11-09',
    })
    expect(weekRange(new Date('2026-11-15T23:59:59.999Z'), 'UTC').key).toBe('2026-11-09')
    expect(weekRange(new Date('2026-11-16T00:00:00.000Z'), 'UTC').key).toBe('2026-11-16')
    expect(weekRange(new Date('2026-11-15T22:30:00.000Z'), 'Europe/Moscow')).toEqual({
      from: '2026-11-15T21:00:00.000Z',
      to: '2026-11-22T21:00:00.000Z',
      key: '2026-11-16',
    })
    expect(weekRange(new Date('2026-12-30T00:00:00.000Z'), 'UTC').key).toBe('2026-12-28')
  })

  test('a week across a daylight saving change starts at local midnight on both ends', () => {
    expect(weekRange(new Date('2026-10-21T12:00:00.000Z'), 'Europe/Berlin')).toEqual({
      from: '2026-10-18T22:00:00.000Z',
      to: '2026-10-25T23:00:00.000Z',
      key: '2026-10-19',
    })
    expect(weekRange(new Date('2026-10-28T12:00:00.000Z'), 'Europe/Berlin').from).toBe(
      '2026-10-25T23:00:00.000Z',
    )
  })

  test('previousWeek steps back one local week', () => {
    const week = weekRange(new Date('2026-10-28T12:00:00.000Z'), 'Europe/Berlin')
    expect(previousWeek(week, 'Europe/Berlin')).toEqual({
      from: '2026-10-18T22:00:00.000Z',
      to: '2026-10-25T23:00:00.000Z',
      key: '2026-10-19',
    })
  })

  test('period spans compare the same elapsed span of the period before', () => {
    const now = new Date('2026-11-12T12:00:00.000Z')
    expect(periodSpans('week', now, 'UTC')).toEqual({
      current: { from: '2026-11-09T00:00:00.000Z', to: now.toISOString(), key: '2026-11-09' },
      comparison: {
        from: '2026-11-02T00:00:00.000Z',
        to: '2026-11-05T12:00:00.000Z',
        key: '2026-11-02',
      },
    })
    expect(periodSpans('month', now, 'UTC')).toEqual({
      current: { from: '2026-11-01T00:00:00.000Z', to: now.toISOString(), key: '2026-11' },
      comparison: {
        from: '2026-10-01T00:00:00.000Z',
        to: '2026-10-12T12:00:00.000Z',
        key: '2026-10',
      },
    })
    expect(periodSpans('month', new Date('2026-03-31T10:00:00.000Z')).comparison.to).toBe(
      '2026-03-01T00:00:00.000Z',
    )
    expect(periodSpans('30d', now)).toEqual({
      current: { from: '2026-10-13T12:00:00.000Z', to: now.toISOString(), key: '30d:2026-11-12' },
      comparison: {
        from: '2026-09-13T12:00:00.000Z',
        to: '2026-10-13T12:00:00.000Z',
        key: '30d:2026-10-13',
      },
    })
  })
})

describe('budget values', () => {
  test('defaults to $150 a week with a $25 reserve that blocks', () => {
    expect(budgetSchema.parse({})).toEqual({
      weeklyUsd: 150,
      reserveUsd: 25,
      action: 'block',
      warnPercent: 80,
    })
    expect(budgetSchema.safeParse({ weeklyUsd: 0 }).success).toBeFalse()
    expect(budgetSchema.safeParse({ reserveUsd: -1 }).success).toBeFalse()
  })
})

describe('budget resolution', () => {
  test('most specific covering budget plus the global one; invalid values skipped', () => {
    const budgets = parseBudgets([
      entry('global', { all: true }, { weeklyUsd: 100, action: 'warn' }),
      entry('games', { groups: ['games'] }, { weeklyUsd: 50 }),
      entry('glob', { repos: ['work:games/**'] }, { weeklyUsd: 20 }),
      entry('exact', { repos: ['work:games/app'] }, { weeklyUsd: 2, reserveUsd: 1 }),
      entry('broken', { repos: ['work:games/app'] }, { action: 'explode' }),
      { ...entry('other', { all: true }, { weeklyUsd: 1 }), key: 'llm.model' },
    ])
    expect(budgets.map((b) => b.id)).toEqual(['global', 'games', 'glob', 'exact'])
    expect(applicableBudgets(budgets, app).map((b) => b.id)).toEqual(['exact', 'global'])
    expect(
      applicableBudgets(budgets, { forge: 'work', path: 'games/adventure', groups: [] }).map(
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
      entry('old', { groups: ['games'] }, { weeklyUsd: 1 }, '2026-01-01T00:00:00Z'),
      entry('new', { groups: ['games'] }, { weeklyUsd: 2 }, '2026-02-01T00:00:00Z'),
    ])
    expect(applicableBudgets(budgets, app).map((b) => b.id)).toEqual(['new'])
  })
})

const setup = async (entries: SettingEntry[], records: NewAiUsageRecord[]) => {
  const store: Store = memoryStore()
  for (const e of entries) await store.settings.put(e)
  for (const r of records) await store.aiUsage.append(r)
  let now = new Date('2026-10-30T12:00:00.000Z')
  const guard = budgetGuard({
    settings: store.settings,
    usage: store.aiUsage,
    audit: store.audit,
    now: () => now,
    timeZone: 'UTC',
    cacheMs: 1000,
  })
  return { store, guard, setNow: (value: string) => (now = new Date(value)) }
}

describe('budgetGuard', () => {
  test('automatic work stops at the reserve, interactive work may use it', async () => {
    const { guard, store } = await setup(
      [entry('global', { all: true }, { weeklyUsd: 10, reserveUsd: 3 })],
      [spend('2026-10-27T00:00:00.000Z', 6), spend('2026-10-20T00:00:00.000Z', 100)],
    )
    const automatic = await guard.check({ repo: app, taskKind: 'review', estimateUsd: 1.5 })
    expect(automatic.allowed).toBeFalse()
    expect(automatic.exceeded).toEqual([
      {
        budgetId: 'global',
        scope: { all: true },
        action: 'block',
        week: '2026-10-26',
        weeklyUsd: 10,
        reserveUsd: 3,
        limitUsd: 7,
        spentUsd: 6,
        estimateUsd: 1.5,
        interactive: false,
      },
    ])
    expect(automatic.remainingUsd).toBe(1)
    const person = await guard.check({
      repo: app,
      taskKind: 'review',
      estimateUsd: 1.5,
      interactive: true,
    })
    expect(person).toEqual({ allowed: true, exceeded: [], remainingUsd: 4 })
    expect(
      (await guard.check({ repo: app, taskKind: 'review', estimateUsd: 5, interactive: true }))
        .allowed,
    ).toBeFalse()
    const { events } = await store.audit.list()
    expect(events.map((e) => `${e.action} ${e.target.id}`)).toEqual([
      'ai.budget_exceeded global',
      'ai.budget_exceeded global',
    ])
  })

  test('the estimate defaults to the mean cost of this week’s runs of the task kind', async () => {
    const { guard } = await setup(
      [entry('global', { all: true }, { weeklyUsd: 10, reserveUsd: 0 })],
      [
        spend('2026-10-27T00:00:00.000Z', 2),
        spend('2026-10-28T00:00:00.000Z', 4),
        spend('2026-10-28T00:00:00.000Z', 0, { outcome: 'denied-budget' }),
        spend('2026-10-28T00:00:00.000Z', 1, { taskKind: 'port' }),
      ],
    )
    const review = await guard.check({ repo: app, taskKind: 'review' })
    expect(review.allowed).toBeTrue()
    const tight = await setup(
      [entry('global', { all: true }, { weeklyUsd: 8.5, reserveUsd: 0 })],
      [spend('2026-10-27T00:00:00.000Z', 2), spend('2026-10-28T00:00:00.000Z', 4)],
    )
    expect((await tight.guard.check({ repo: app, taskKind: 'review' })).exceeded).toMatchObject([
      { estimateUsd: 3, spentUsd: 6 },
    ])
    expect((await tight.guard.check({ repo: app, taskKind: 'lint' })).allowed).toBeTrue()
  })

  test('warn only reports; a repository budget applies with the global one', async () => {
    const { guard } = await setup(
      [
        entry('repo', { repos: ['work:games/app'] }, { weeklyUsd: 5, reserveUsd: 0 }),
        entry('global', { all: true }, { weeklyUsd: 4, reserveUsd: 0, action: 'warn' }),
      ],
      [spend('2026-10-27T00:00:00.000Z', 4.5)],
    )
    const decision = await guard.check({ repo: app, taskKind: 'review', estimateUsd: 0 })
    expect(decision.allowed).toBeTrue()
    expect(decision.exceeded.map((s) => [s.budgetId, s.action])).toEqual([['global', 'warn']])
    expect(decision.remainingUsd).toBe(0.5)
    const other = await guard.check({
      repo: { forge: 'work', path: 'tools/cli', groups: [] },
      taskKind: 'review',
      estimateUsd: 0,
    })
    expect(other.allowed).toBeTrue()
    expect(other.remainingUsd).toBeUndefined()
  })

  test('without a global entry the default budget applies', async () => {
    const { guard } = await setup([], [spend('2026-10-27T00:00:00.000Z', 124)])
    expect((await guard.check({ repo: app, taskKind: 'review', estimateUsd: 2 })).exceeded).toEqual(
      [expect.objectContaining({ budgetId: 'default', limitUsd: 125, weeklyUsd: 150 })],
    )
    expect(
      (await guard.check({ repo: app, taskKind: 'review', estimateUsd: 2, interactive: true }))
        .allowed,
    ).toBeTrue()
  })

  test('the audit event fires once per budget, week and kind of work', async () => {
    const { guard, store, setNow } = await setup(
      [entry('global', { all: true }, { weeklyUsd: 1, reserveUsd: 0, action: 'warn' })],
      [spend('2026-10-27T01:00:00.000Z', 2), spend('2026-11-03T01:00:00.000Z', 2)],
    )
    await guard.check({ repo: app, taskKind: 'review' })
    await guard.check({ repo: app, taskKind: 'review' })
    expect(await store.audit.count()).toBe(1)
    setNow('2026-11-03T12:00:00.000Z')
    expect((await guard.check({ repo: app, taskKind: 'review' })).exceeded.length).toBe(1)
    expect(await store.audit.count()).toBe(2)
  })

  test('the week resets on Monday', async () => {
    const { guard, setNow } = await setup(
      [entry('global', { all: true }, { weeklyUsd: 5, reserveUsd: 0 })],
      [spend('2026-11-01T23:59:59.999Z', 5)],
    )
    setNow('2026-11-01T23:59:59.999Z')
    expect((await guard.check({ repo: app, taskKind: 'x', estimateUsd: 0.1 })).allowed).toBeFalse()
    setNow('2026-11-02T00:00:00.000Z')
    expect(await guard.check({ repo: app, taskKind: 'x', estimateUsd: 0.1 })).toEqual({
      allowed: true,
      exceeded: [],
      remainingUsd: 5,
    })
  })

  test('cached spend is reused, bumped by note and refreshed after cacheMs', async () => {
    const budget = entry('global', { all: true }, { weeklyUsd: 5, reserveUsd: 0 })
    const { guard, store, setNow } = await setup([budget], [spend('2026-10-27T00:00:00.000Z', 4)])
    const check = () => guard.check({ repo: app, taskKind: 'r', estimateUsd: 0.5 })
    expect((await check()).allowed).toBeTrue()
    await store.aiUsage.append(spend('2026-10-30T12:00:00.000Z', 3))
    expect((await check()).allowed).toBeTrue()
    setNow('2026-10-30T12:00:02.000Z')
    expect((await check()).allowed).toBeFalse()

    const fresh = await setup([budget], [spend('2026-10-27T00:00:00.000Z', 4)])
    const again = () => fresh.guard.check({ repo: app, taskKind: 'r', estimateUsd: 0.5 })
    expect((await again()).allowed).toBeTrue()
    fresh.guard.note(spend('2026-10-30T12:00:00.000Z', 1))
    expect((await again()).allowed).toBeFalse()
  })
})

test('budgetStatuses reports weekly spend, percent, forecast and when automatic work stops', async () => {
  const store = memoryStore()
  await store.aiUsage.append(spend('2026-11-09T01:00:00.000Z', 3))
  await store.aiUsage.append(spend('2026-11-10T00:00:00.000Z', 2, { taskKind: 'port' }))
  await store.aiUsage.append(spend('2026-11-08T00:00:00.000Z', 50))
  const now = new Date('2026-11-12T12:00:00.000Z')
  const [status] = await budgetStatuses(
    [entry('g', { groups: ['games'] }, { weeklyUsd: 20, reserveUsd: 5, action: 'warn' })],
    store.aiUsage,
    now,
    { timeZone: 'UTC' },
  )
  expect(status).toEqual({
    id: 'g',
    scope: { groups: ['games'] },
    action: 'warn',
    weeklyUsd: 20,
    reserveUsd: 5,
    warnPercent: 80,
    spentUsd: 5,
    automaticUsd: 5,
    percent: 25,
    forecastUsd: 55,
    automaticStopsAt: '2026-11-13T04:48:00.000Z',
    week: { from: '2026-11-09T00:00:00.000Z', to: '2026-11-16T00:00:00.000Z', key: '2026-11-09' },
  })
  expect(
    (await budgetStatuses([], store.aiUsage, now, { timeZone: 'UTC', includeDefault: true })).map(
      (s) => [s.id, s.weeklyUsd, s.reserveUsd, s.spentUsd, s.automaticStopsAt],
    ),
  ).toEqual([['default', 150, 25, 5, undefined]])
})

const status = (id: string, scope: Scope, percent: number) => ({ id, scope, percent })

test('broadestBudget prefers a global budget, then the least specific, then the fullest', () => {
  expect(
    broadestBudget([
      status('repo', { repos: ['work:games/app'] }, 90),
      status('all', { all: true }, 10),
    ])?.id,
  ).toBe('all')
  expect(
    broadestBudget([
      status('repo', { repos: ['work:games/app'] }, 90),
      status('games', { groups: ['games'] }, 10),
      status('tools', { groups: ['tools'] }, 40),
    ])?.id,
  ).toBe('tools')
  expect(broadestBudget([])).toBeUndefined()
})

describe('spendForecast', () => {
  const now = new Date('2026-11-12T12:00:00.000Z')

  test('adds the mean of the same remaining span of the last 4 full weeks', async () => {
    const store = memoryStore()
    const records = [
      spend('2026-11-09T08:00:00.000Z', 6),
      spend('2026-11-10T08:00:00.000Z', 4, { interactive: true, actor: 'jane' }),
      spend('2026-11-07T08:00:00.000Z', 8),
      spend('2026-11-03T08:00:00.000Z', 100),
      spend('2026-10-31T08:00:00.000Z', 4, { interactive: true, actor: 'jane' }),
      spend('2026-10-24T08:00:00.000Z', 12),
      spend('2026-10-17T08:00:00.000Z', 20),
      spend('2026-10-10T08:00:00.000Z', 999),
    ]
    await Promise.all(records.map((record) => store.aiUsage.append(record)))
    expect(await spendForecast(store.aiUsage, now, { timeZone: 'UTC' })).toEqual({
      week: { from: '2026-11-09T00:00:00.000Z', to: '2026-11-16T00:00:00.000Z', key: '2026-11-09' },
      spentUsd: 10,
      automaticUsd: 6,
      forecastUsd: 10 + (8 + 4 + 12 + 20) / 4,
      automaticForecastUsd: 6 + (8 + 12 + 20) / 4,
      automaticWeeklyMeanUsd: (108 + 12 + 20) / 4,
      weeks: 4,
    })
    const people = await spendForecast(store.aiUsage, now, {
      timeZone: 'UTC',
      filter: { origin: 'interactive' },
    })
    expect(people).toMatchObject({ spentUsd: 4, forecastUsd: 4 + 4 / 2, weeks: 2 })
  })

  test('without a full past week the pace so far is extended to the week end', async () => {
    const store = memoryStore()
    await store.aiUsage.append(spend('2026-11-10T08:00:00.000Z', 7))
    expect(await spendForecast(store.aiUsage, now, { timeZone: 'UTC' })).toMatchObject({
      spentUsd: 7,
      forecastUsd: 14,
      automaticForecastUsd: 14,
      automaticWeeklyMeanUsd: 14,
      weeks: 0,
    })
    const early = new Date('2026-11-09T06:00:00.000Z')
    await store.aiUsage.append(spend('2026-11-09T01:00:00.000Z', 1))
    expect((await spendForecast(store.aiUsage, early, { timeZone: 'UTC' })).forecastUsd).toBe(7)
    expect((await spendForecast(memoryStore().aiUsage, now, { timeZone: 'UTC' })).forecastUsd).toBe(
      0,
    )
  })
})

test('automaticStopsAt spreads the forecast over the rest of the week', () => {
  const week = {
    from: '2026-11-09T00:00:00.000Z',
    to: '2026-11-16T00:00:00.000Z',
    key: '2026-11-09',
  }
  const now = new Date('2026-11-12T12:00:00.000Z')
  const budget = { weeklyUsd: 150, reserveUsd: 25 }
  expect(automaticStopsAt(budget, { week, spentUsd: 100, forecastUsd: 150 }, now)).toBe(
    '2026-11-14T06:00:00.000Z',
  )
  expect(automaticStopsAt(budget, { week, spentUsd: 100, forecastUsd: 125 }, now)).toBeUndefined()
  expect(automaticStopsAt(budget, { week, spentUsd: 125, forecastUsd: 200 }, now)).toBeUndefined()
})
