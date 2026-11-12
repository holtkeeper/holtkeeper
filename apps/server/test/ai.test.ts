import { beforeEach, describe, expect, test } from 'bun:test'

import { weekRange } from '@holtkeeper/ai-usage'
import type { AiRunList, AiUsageBuckets, AiUsageOverview, AiWeekBreakdown } from '@holtkeeper/api'
import type { AuthProvider } from '@holtkeeper/auth'
import { headerAuth } from '@holtkeeper/auth-header'
import { noAuth } from '@holtkeeper/auth-none'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { builtinSettings } from '@holtkeeper/settings'
import type { NewAiUsageRecord, Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { createApp } from '../src/app.ts'

const config = parseConfig({
  forges: { work: { kind: 'fake', url: 'https://forge.test', create: () => ({}) as never } },
  groups: {
    games: { forge: 'work', include: ['games/*'] },
    tools: { forge: 'work', include: ['tools/*'] },
  },
})

let store: Store
const setup = (auth: AuthProvider = noAuth(), at = '2026-11-16T00:00:00.000Z') => {
  const vault = aesVault('v'.repeat(32))
  return createApp({
    config,
    auth,
    store,
    vault,
    credentials: createCredentialService({
      credentials: store.credentials,
      vault,
    }),
    settings: builtinSettings,
    analyses: [],
    now: () => new Date(at),
  })
}

const teams = headerAuth({
  roles: {
    'games-ai': [{ scope: { groups: ['games'] }, actions: ['ai:read'] }],
    'games-knowledge': [{ scope: { groups: ['games'] }, actions: ['knowledge:read'] }],
    'tools-ai': [{ scope: { groups: ['tools'] }, actions: ['ai:read'] }],
    'people-reader': [
      { scope: { groups: ['tools'] }, actions: ['ai:read'] },
      { scope: { groups: ['tools'] }, actions: ['users:read'] },
    ],
  },
})
const as = (group: string) => ({ 'x-forwarded-user': 'jane', 'x-forwarded-groups': group })

const run = (
  at: string,
  path: string,
  overrides: Partial<NewAiUsageRecord> = {},
): NewAiUsageRecord => ({
  at,
  repo: { forge: 'work', path },
  groups: [path.split('/')[0] ?? ''],
  taskKind: 'review',
  actor: 'system',
  provider: 'anthropic',
  model: 'claude-opus-5-5',
  inputTokens: 100,
  outputTokens: 10,
  cacheReadTokens: 300,
  cacheWriteTokens: 0,
  costUsd: 1,
  costSource: 'reported',
  durationMs: 1000,
  turns: 1,
  outcome: 'ok',
  ...overrides,
})

const get = async (
  app: ReturnType<typeof setup>,
  path: string,
  headers: Record<string, string> = {},
) => {
  const response = await app.request(path, { headers })
  const body: unknown = await response.json()
  return { status: response.status, body }
}

type App = ReturnType<typeof setup>
type Headers = Record<string, string>

const read = async (app: App, path: string, headers: Headers = {}) => {
  const response = await app.request(path, { headers })
  return { status: response.status, json: response.json() }
}

const getUsage = async (app: App, path: string, headers?: Headers) => {
  const { status, json } = await read(app, path, headers)
  return { status, body: (await json) as AiUsageBuckets }
}

const getRuns = async (app: App, path: string, headers?: Headers) => {
  const { status, json } = await read(app, path, headers)
  return { status, body: (await json) as AiRunList }
}

const getOverview = async (app: App, path: string, headers?: Headers) => {
  const { status, json } = await read(app, path, headers)
  return { status, body: (await json) as AiUsageOverview }
}

const getWeek = async (app: App, path: string, headers?: Headers) => {
  const { status, json } = await read(app, path, headers)
  return { status, body: (await json) as AiWeekBreakdown }
}

const thursday = '2026-11-12T12:00:00.000Z'

/** A week of usage around `thursday`, at noon so no time zone moves a run into another week. */
async function seedWeeks(budget: { weeklyUsd: number; reserveUsd: number }) {
  store = memoryStore()
  await store.aiUsage.append(
    run('2026-11-10T12:00:00.000Z', 'games/app', { costUsd: 2, analyzer: 'review', jobId: 'j7' }),
  )
  await store.aiUsage.append(
    run('2026-11-11T12:00:00.000Z', 'tools/cli', {
      costUsd: 3,
      taskKind: 'chat',
      actor: 'jane',
      interactive: true,
      subject: 'thread about widgets',
      provider: 'gateway',
    }),
  )
  await store.aiUsage.append(
    run('2026-11-11T13:00:00.000Z', 'games/adventure', {
      costUsd: 0,
      costSource: 'unknown',
      model: 'mystery-model',
      analyzer: 'review',
    }),
  )
  await store.aiUsage.append(run('2026-11-03T12:00:00.000Z', 'games/app', { costUsd: 1 }))
  await store.aiUsage.append(run('2026-11-06T12:00:00.000Z', 'games/app', { costUsd: 4 }))
  await store.settings.put({
    id: 'games-budget',
    key: 'llm.budget',
    scope: { groups: ['games'] },
    value: { weeklyUsd: 3, reserveUsd: 1, action: 'block' },
    secret: false,
    updatedAt: '2026-11-01T00:00:00.000Z',
  })
  await store.settings.put({
    id: 'global-budget',
    key: 'llm.budget',
    scope: { all: true },
    value: { ...budget, action: 'warn' },
    secret: false,
    updatedAt: '2026-11-01T00:00:00.000Z',
  })
}

beforeEach(async () => {
  store = memoryStore()
  await store.aiUsage.append(run('2026-10-10T00:00:00.000Z', 'games/app', { costUsd: 4 }))
  await store.aiUsage.append(run('2026-11-02T00:00:00.000Z', 'games/app', { jobId: 'j1' }))
  await store.aiUsage.append(
    run('2026-11-03T00:00:00.000Z', 'games/adventure', {
      model: 'claude-sonnet-5-5',
      outcome: 'error',
      error: 'boom',
      costUsd: 0.5,
    }),
  )
  await store.aiUsage.append(
    run('2026-11-04T00:00:00.000Z', 'tools/cli', { taskKind: 'port', costUsd: 3 }),
  )
  await store.settings.put({
    id: 'games-budget',
    key: 'llm.budget',
    scope: { groups: ['games'] },
    value: { weeklyUsd: 3, reserveUsd: 1, action: 'block' },
    secret: false,
    updatedAt: '2026-11-01T00:00:00.000Z',
  })
  await store.settings.put({
    id: 'global-budget',
    key: 'llm.budget',
    scope: { all: true },
    value: { weeklyUsd: 100, action: 'warn' },
    secret: false,
    updatedAt: '2026-11-01T00:00:00.000Z',
  })
})

describe('ai routes', () => {
  test('usage aggregates with groupBy, filters and totals', async () => {
    const app = setup()
    const { status, body } = await getUsage(
      app,
      '/api/ai/usage?from=2026-10-01T00:00:00Z&groupBy=month,repo',
    )
    expect(status).toBe(200)
    expect(body.buckets.map((b) => [b.key.month, b.key.repo, b.costUsd])).toEqual([
      ['2026-10', 'work:games/app', 4],
      ['2026-11', 'work:games/adventure', 0.5],
      ['2026-11', 'work:games/app', 1],
      ['2026-11', 'work:tools/cli', 3],
    ])
    expect(body.totals).toMatchObject({ runs: 4, errors: 1, costUsd: 8.5 })

    const filtered = await getUsage(
      app,
      '/api/ai/usage?from=2026-10-01&model=claude-sonnet-5-5&groupBy=taskKind',
    )
    expect(filtered.body.buckets.map((b) => [b.key.taskKind, b.runs])).toEqual([['review', 1]])

    const defaultWindow = await getUsage(app, '/api/ai/usage')
    expect(defaultWindow.body.from).toBe('2026-10-17T00:00:00.000Z')
    expect(defaultWindow.body.totals.runs).toBe(3)

    expect((await get(app, '/api/ai/usage?groupBy=color')).status).toBe(400)
    expect((await get(app, '/api/ai/usage?from=yesterday')).status).toBe(400)
    expect((await get(app, '/api/ai/runs?outcome=maybe')).status).toBe(400)
  })

  test('runs page newest first with a cursor and job links', async () => {
    const app = setup()
    const first = await getRuns(app, '/api/ai/runs?limit=2')
    expect(first.body.runs.map((r) => r.repo.path)).toEqual(['tools/cli', 'games/adventure'])
    expect(first.body.next).toBe('2026-11-03T00:00:00.000Z')
    const second = await getRuns(app, `/api/ai/runs?limit=2&before=${first.body.next}`)
    expect(second.body.runs.map((r) => r.at.slice(5, 10))).toEqual(['11-02', '10-10'])
    expect(second.body.runs[0]?.jobId).toBe('j1')
    expect(second.body.next).toBeUndefined()
    const repo = await getRuns(app, '/api/ai/runs?repo=work:games/adventure')
    expect(repo.body.runs.map((r) => r.error)).toEqual(['boom'])
  })

  test('overview: this week against the same span last week, tops, budgets, forecast', async () => {
    await seedWeeks({ weeklyUsd: 10, reserveUsd: 2 })
    const now = new Date(thursday)
    const week = weekRange(now)
    const { status, body } = await getOverview(setup(noAuth(), thursday), '/api/ai/overview')
    expect(status).toBe(200)
    expect(body.period).toBe('week')
    expect(body.current).toMatchObject({
      key: week.key,
      from: week.from,
      to: thursday,
      automaticUsd: 2,
      totals: { runs: 3, costUsd: 5, unknownCost: 1 },
    })
    expect(body.comparison).toMatchObject({ totals: { runs: 1, costUsd: 1 } })
    expect(body.topRepos.map((b) => b.key.repo)).toEqual([
      'work:tools/cli',
      'work:games/app',
      'work:games/adventure',
    ])
    expect(body.topAnalyzers.map((b) => [b.key.analyzer, b.costUsd])).toEqual([
      ['', 3],
      ['review', 2],
    ])
    expect(body.topTaskKinds.map((b) => b.key.taskKind)).toEqual(['chat', 'review'])
    expect(body.forecast).toMatchObject({ spentUsd: 5, automaticUsd: 2, forecastUsd: 9, weeks: 1 })
    expect(body.cacheHitRatio).toBeCloseTo(0.75)
    expect(body.errorRate).toBe(0)
    const left = Date.parse(week.to) - now.getTime()
    const stops = new Date(now.getTime() + Math.floor((left * 3) / 4)).toISOString()
    const global = body.budgets.find((b) => b.id === 'global-budget')
    expect(global).toMatchObject({ spentUsd: 5, forecastUsd: 9, automaticStopsAt: stops })
    expect(body.automaticStopsAt).toBe(stops)
    const games = body.budgets.find((b) => b.id === 'games-budget')
    expect(games).toEqual({
      id: 'games-budget',
      scope: { groups: ['games'] },
      action: 'block',
      weeklyUsd: 3,
      reserveUsd: 1,
      warnPercent: 80,
      spentUsd: 2,
      automaticUsd: 2,
      percent: (2 / 3) * 100,
      forecastUsd: 6,
      week,
    })
  })

  test('overview: month and 30 days, groups narrow and never widen', async () => {
    await seedWeeks({ weeklyUsd: 100, reserveUsd: 25 })
    const month = await getOverview(setup(noAuth(), thursday), '/api/ai/overview?period=month')
    expect(month.body.current).toMatchObject({ key: '2026-11', totals: { costUsd: 10 } })
    expect(month.body.comparison).toMatchObject({ key: '2026-10', totals: { runs: 0 } })
    expect(month.body.automaticStopsAt).toBeUndefined()
    const days = await getOverview(setup(noAuth(), thursday), '/api/ai/overview?period=30d')
    expect(days.body.current.key).toBe('30d:2026-11-12')
    expect((await get(setup(), '/api/ai/overview?period=year')).status).toBe(400)

    const tools = await getOverview(setup(noAuth(), thursday), '/api/ai/overview?groups=tools')
    expect(tools.body.current.totals.costUsd).toBe(3)
    expect(tools.body.forecast).toMatchObject({ spentUsd: 3, weeks: 0 })
    expect(tools.body.topRepos.map((b) => b.key.repo)).toEqual(['work:tools/cli'])

    const app = setup(teams, thursday)
    const narrow = await getOverview(app, '/api/ai/overview?groups=tools,games', as('games-ai'))
    expect(narrow.body.current.totals.costUsd).toBe(2)
    expect(narrow.body.topRepos.map((b) => b.key.repo)).not.toContain('work:tools/cli')
    expect(narrow.body.forecast.spentUsd).toBe(2)
    const outside = await getOverview(app, '/api/ai/overview?groups=tools', as('games-ai'))
    expect(outside.body.current.totals.runs).toBe(0)
    expect(outside.body.topRepos).toEqual([])
    expect(outside.body.budgets.map((b) => b.id)).toEqual(['games-budget'])
    expect((await get(app, '/api/ai/overview?groups=tools', as('games-knowledge'))).status).toBe(
      403,
    )
  })

  test('week: spend by task kind, analyzer and provider within what the caller may read', async () => {
    await seedWeeks({ weeklyUsd: 100, reserveUsd: 25 })
    const week = weekRange(new Date(thursday))
    const all = await getWeek(setup(noAuth(), thursday), '/api/ai/week')
    expect(all.status).toBe(200)
    expect(all.body.week).toEqual(week)
    expect(all.body.totals).toMatchObject({ runs: 3, costUsd: 5, unknownCost: 1 })
    expect(all.body.byTaskKind.map((b) => [b.key.taskKind, b.costUsd])).toEqual([
      ['chat', 3],
      ['review', 2],
    ])
    expect(all.body.byAnalyzer.map((b) => [b.key.analyzer, b.runs])).toEqual([
      ['', 1],
      ['review', 2],
    ])
    expect(all.body.byProvider.map((b) => b.key.provider)).toEqual(['gateway', 'anthropic'])

    const previous = weekRange(new Date(Date.parse(week.from) - 1))
    const last = await getWeek(setup(noAuth(), thursday), `/api/ai/week?week=${previous.key}`)
    expect(last.body.totals.costUsd).toBe(5)
    expect((await get(setup(), '/api/ai/week?week=2026-11-10')).status).toBe(400)
    expect((await get(setup(), '/api/ai/week?week=soon')).status).toBe(400)

    const app = setup(teams, thursday)
    const narrow = await getWeek(app, '/api/ai/week', as('games-ai'))
    expect(narrow.body.totals.costUsd).toBe(2)
    expect(narrow.body.byTaskKind.map((b) => b.key.taskKind)).toEqual(['review'])
    expect((await getWeek(app, '/api/ai/week?groups=tools', as('games-ai'))).body.totals.runs).toBe(
      0,
    )
    expect((await get(app, '/api/ai/week', as('games-knowledge'))).status).toBe(403)
  })

  test('runs and usage filter by actor, origin and groups', async () => {
    await seedWeeks({ weeklyUsd: 100, reserveUsd: 25 })
    const app = setup(noAuth(), thursday)
    const people = await getRuns(app, '/api/ai/runs?origin=interactive')
    expect(people.body.runs.map((r) => [r.actor, r.subject])).toEqual([
      ['jane', 'thread about widgets'],
    ])
    expect((await getRuns(app, '/api/ai/runs?actor=jane')).body.runs).toHaveLength(1)
    const automatic = await getUsage(app, '/api/ai/usage?origin=automatic&groups=games')
    expect(automatic.body.totals).toMatchObject({ runs: 4, costUsd: 7 })
    expect((await get(app, '/api/ai/runs?origin=bot')).status).toBe(400)
    const narrow = await getRuns(
      setup(teams, thursday),
      '/api/ai/runs?groups=tools',
      as('games-ai'),
    )
    expect(narrow.body.runs).toEqual([])
  })

  test('runs name their people only for callers who may read people', async () => {
    await seedWeeks({ weeklyUsd: 100, reserveUsd: 25 })
    await store.users.putUser({
      id: 'jane',
      name: 'Jane Widget',
      grants: [],
      disabled: false,
      sessionVersion: 1,
      createdAt: '2026-11-01T00:00:00.000Z',
    })
    const app = setup(teams, thursday)
    const named = await getRuns(app, '/api/ai/runs', as('people-reader'))
    expect(named.body.people).toEqual({
      jane: { name: 'Jane Widget', avatarUrl: expect.any(String) },
    })
    expect((await getRuns(app, '/api/ai/runs', as('tools-ai'))).body.people).toBeUndefined()
    expect(
      Object.keys((await getRuns(setup(noAuth(), thursday), '/api/ai/runs')).body.people ?? {}),
    ).toEqual(['jane'])
  })

  test('overview: the default budget stands in for a missing global one', async () => {
    await store.settings.remove('global-budget')
    const { body } = await getOverview(setup(), '/api/ai/overview')
    expect(
      body.budgets
        .map((b) => [b.id, b.weeklyUsd, b.reserveUsd])
        .toSorted((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ['default', 150, 25],
      ['games-budget', 3, 1],
    ])
    const scoped = await getOverview(setup(teams), '/api/ai/overview', as('games-ai'))
    expect(scoped.body.budgets.map((b) => b.id)).toEqual(['games-budget'])
  })

  test('rows and budgets are limited to the caller’s ai:read scopes', async () => {
    const app = setup(teams)
    expect((await app.request('/api/ai/usage')).status).toBe(401)
    expect((await get(app, '/api/ai/overview', as('games-knowledge'))).status).toBe(403)
    expect((await get(app, '/api/ai/runs', as('games-knowledge'))).status).toBe(403)

    const runs = await getRuns(app, '/api/ai/runs', as('games-ai'))
    expect(runs.body.runs.map((r) => r.repo.path)).toEqual([
      'games/adventure',
      'games/app',
      'games/app',
    ])
    const usage = await getUsage(app, '/api/ai/usage?from=2026-01-01&groupBy=repo', as('games-ai'))
    expect(usage.body.buckets.map((b) => b.key.repo)).toEqual([
      'work:games/adventure',
      'work:games/app',
    ])
    expect(usage.body.totals.costUsd).toBeCloseTo(5.5)
    expect((await get(app, '/api/ai/runs?repo=work:tools/cli', as('games-ai'))).status).toBe(403)

    const overview = await getOverview(app, '/api/ai/overview?period=month', as('games-ai'))
    expect(overview.body.current.totals.costUsd).toBeCloseTo(1.5)
    expect(overview.body.topRepos.map((b) => b.key.repo)).not.toContain('work:tools/cli')
    expect(overview.body.budgets.map((b) => b.id)).toEqual(['games-budget'])
  })
})
