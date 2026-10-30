import { beforeEach, describe, expect, test } from 'bun:test'

import type { AiRunList, AiUsageBuckets, AiUsageOverview } from '@holtkeeper/api'
import type { AuthProvider } from '@holtkeeper/auth'
import { headerAuth } from '@holtkeeper/auth-header'
import { noAuth } from '@holtkeeper/auth-none'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { builtinSettings } from '@holtkeeper/settings'
import type { AiUsageRecord, Store } from '@holtkeeper/store'
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
const setup = (auth: AuthProvider = noAuth()) => {
  const vault = aesVault('v'.repeat(32))
  return createApp({
    config,
    auth,
    store,
    vault,
    credentials: createCredentialService({
      credentials: store.credentials,
      activity: store.activity,
      vault,
    }),
    settings: builtinSettings,
    analyses: [],
    now: () => new Date('2026-11-16T00:00:00.000Z'),
  })
}

const teams = headerAuth({
  roles: {
    'games-ai': [{ scope: { groups: ['games'] }, actions: ['ai:read'] }],
    'games-knowledge': [{ scope: { groups: ['games'] }, actions: ['knowledge:read'] }],
  },
})
const as = (group: string) => ({ 'x-forwarded-user': 'jane', 'x-forwarded-groups': group })

const run = (
  at: string,
  path: string,
  overrides: Partial<Omit<AiUsageRecord, 'id'>> = {},
): Omit<AiUsageRecord, 'id'> => ({
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
    value: { monthlyUsd: 3, action: 'block' },
    secret: false,
    updatedAt: '2026-11-01T00:00:00.000Z',
  })
  await store.settings.put({
    id: 'global-budget',
    key: 'llm.budget',
    scope: { all: true },
    value: { monthlyUsd: 100, action: 'warn' },
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

  test('overview: month vs last month, tops, budgets, ratios', async () => {
    const { status, body } = await getOverview(setup(), '/api/ai/overview')
    expect(status).toBe(200)
    expect(body.month).toMatchObject({ key: '2026-11', totals: { runs: 3, costUsd: 4.5 } })
    expect(body.previousMonth).toMatchObject({ key: '2026-10', totals: { runs: 1, costUsd: 4 } })
    expect(body.topRepos.map((b) => b.key.repo)).toEqual([
      'work:tools/cli',
      'work:games/app',
      'work:games/adventure',
    ])
    expect(body.topModels.map((b) => b.key.model)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5'])
    expect(body.topTaskKinds.map((b) => b.key.taskKind)).toEqual(['port', 'review'])
    expect(body.cacheHitRatio).toBeCloseTo(0.75)
    expect(body.errorRate).toBeCloseTo(1 / 3)
    const games = body.budgets.find((b) => b.id === 'games-budget')
    expect(games?.limits).toEqual([
      { period: 'month', limitUsd: 3, spentUsd: 1.5, percent: 50, projectedUsd: 3 },
    ])
    expect(body.budgets.map((b) => b.id).toSorted()).toEqual(['games-budget', 'global-budget'])
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

    const overview = await getOverview(app, '/api/ai/overview', as('games-ai'))
    expect(overview.body.month.totals.costUsd).toBeCloseTo(1.5)
    expect(overview.body.topRepos.map((b) => b.key.repo)).not.toContain('work:tools/cli')
    expect(overview.body.budgets.map((b) => b.id)).toEqual(['games-budget'])
  })
})
