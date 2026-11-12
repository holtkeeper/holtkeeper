import { beforeEach, describe, expect, test } from 'bun:test'

import type { Scope } from '@holtkeeper/access'
import type { AgentToolList, AiBudgetOverview, InboxBudgetItem, InboxFeed } from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
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
    web: { forge: 'work', include: ['acme/*-web'] },
    pay: { forge: 'work', include: ['acme/*-api'] },
  },
})

const auth = headerAuth({
  roles: {
    admin: [{ scope: { all: true }, actions: ['*'] }],
    'web-ai': [{ scope: { groups: ['web'] }, actions: ['ai:read'] }],
    'web-owner': [{ scope: { groups: ['web'] }, actions: ['ai:read', 'settings:write'] }],
    'web-docs': [{ scope: { groups: ['web'] }, actions: ['knowledge:read'] }],
  },
})
const as = (role: string) => ({ 'x-forwarded-user': role, 'x-forwarded-groups': role })

let store: Store
let at: string

const appOf = () => {
  const vault = aesVault('v'.repeat(32))
  return createApp({
    config,
    auth,
    store,
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: builtinSettings,
    analyses: [],
    now: () => new Date(at),
  })
}

const get = (path: string, role: string) => appOf().request(`/api${path}`, { headers: as(role) })

const run = (
  path: string,
  costUsd: number,
  overrides: Partial<NewAiUsageRecord> = {},
): NewAiUsageRecord => ({
  at: '2026-11-10T09:00:00.000Z',
  repo: { forge: 'work', path },
  groups: [path.endsWith('-web') ? 'web' : 'pay'],
  taskKind: 'review',
  actor: 'system',
  provider: 'anthropic',
  model: 'model-main',
  inputTokens: 100,
  outputTokens: 10,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd,
  costSource: 'reported',
  durationMs: 1000,
  turns: 1,
  outcome: 'ok',
  ...overrides,
})

const budget = (id: string, scope: Scope, value: object) =>
  store.settings.put({
    id,
    key: 'llm.budget',
    scope,
    value,
    secret: false,
    updatedAt: '2026-11-02T08:00:00.000Z',
    updatedBy: 'user:mira',
  })

beforeEach(async () => {
  store = memoryStore()
  at = '2026-11-12T12:00:00.000Z'
  await store.aiUsage.append(run('acme/checkout-web', 30))
  await store.aiUsage.append(run('acme/checkout-web', 10, { taskKind: 'chat' }))
  await store.aiUsage.append(run('acme/ledger-api', 50, { taskKind: 'write-task' }))
  await store.aiUsage.append(run('acme/ledger-api', 5, { taskKind: '' }))
})

describe('GET /api/ai/budget', () => {
  test('reports the week, the broadest budget, spend per feature and scoped caps', async () => {
    await budget('org', { all: true }, { weeklyUsd: 100, reserveUsd: 20, warnPercent: 90 })
    await budget('web-cap', { groups: ['web'] }, { weeklyUsd: 50, action: 'warn' })
    const response = await get('/ai/budget', 'admin')
    expect(response.status).toBe(200)
    const overview = (await response.json()) as AiBudgetOverview
    expect(overview.week.key).toBe('2026-11-09')
    expect(overview.spentUsd).toBe(95)
    expect(overview.runs).toBe(4)
    expect(overview.budget).toMatchObject({ id: 'org', weeklyUsd: 100, warnPercent: 90 })
    expect(overview.budgetChanged).toEqual({ at: '2026-11-02T08:00:00.000Z', by: 'user:mira' })
    expect(overview.byFeature).toEqual([
      { feature: 'write-task', costUsd: 50, runs: 1 },
      { feature: 'review', costUsd: 30, runs: 1 },
      { feature: 'chat', costUsd: 10, runs: 1 },
      { feature: 'other', costUsd: 5, runs: 1 },
    ])
    expect(overview.scopes).toEqual([
      {
        settingId: 'web-cap',
        scope: { groups: ['web'] },
        weeklyUsd: 50,
        reserveUsd: 25,
        action: 'warn',
        warnPercent: 80,
        spentUsd: 40,
        percent: 80,
      },
    ])
  })

  test('a narrow ai:read sees only its own spend and caps, never the global budget', async () => {
    await budget('org', { all: true }, { weeklyUsd: 100 })
    await budget('web-cap', { groups: ['web'] }, { weeklyUsd: 50 })
    await budget('pay-cap', { groups: ['pay'] }, { weeklyUsd: 70 })
    const overview = (await (await get('/ai/budget', 'web-ai')).json()) as AiBudgetOverview
    expect(overview.spentUsd).toBe(40)
    expect(overview.byFeature.map((entry) => entry.feature)).toEqual(['review', 'chat'])
    expect(overview.budget?.id).toBe('web-cap')
    expect(overview.budgetChanged).toBeUndefined()
    expect(overview.scopes.map((cap) => cap.settingId)).toEqual(['web-cap'])
  })

  test('without ai:read it is forbidden', async () => {
    expect((await get('/ai/budget', 'web-docs')).status).toBe(403)
  })
})

describe('GET /api/ai/tools', () => {
  test('lists the registry with who gets each tool', async () => {
    const response = await get('/ai/tools', 'web-ai')
    expect(response.status).toBe(200)
    const { tools } = (await response.json()) as AgentToolList
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    expect(byName.get('code.search')).toMatchObject({
      toolset: 'code',
      readOnly: true,
      usedBy: ['review', 'write-task'],
    })
    expect(byName.get('start_task')?.usedBy).toEqual(['mcp'])
    expect(byName.get('release_step')?.readOnly).toBeFalse()
    expect(byName.get('repo_rules')?.usedBy).toContain('chat')
    expect(tools.every((tool) => tool.description.length > 0)).toBeTrue()
    expect(tools.map((tool) => `${tool.toolset}/${tool.name}`)).toEqual(
      tools.map((tool) => `${tool.toolset}/${tool.name}`).toSorted(),
    )
  })

  test('without ai:read it is forbidden', async () => {
    expect((await get('/ai/tools', 'web-docs')).status).toBe(403)
  })
})

const budgetItems = async (role: string) => {
  const feed = (await (await get('/inbox', role)).json()) as InboxFeed
  return [...feed.mine, ...feed.teams].filter(
    (item): item is InboxBudgetItem => item.kind === 'budget',
  )
}

describe('budget warnings in the Inbox', () => {
  test('a budget past its warnPercent shows once a week to whoever may change it', async () => {
    await budget('org', { all: true }, { weeklyUsd: 100, warnPercent: 90 })
    await budget('web-cap', { groups: ['web'] }, { weeklyUsd: 50 })
    const items = await budgetItems('admin')
    expect(items.map((item) => item.id)).toEqual([
      'budget:org:2026-11-09',
      'budget:web-cap:2026-11-09',
    ])
    expect(items[0]).toMatchObject({
      title: 'AI spend reached 95% of the $100.00 weekly budget',
      scope: 'All repositories',
      href: '/settings/ai',
      createdAt: '2026-11-12T12:00:00.000Z',
      dueAt: '2026-11-16T00:00:00.000Z',
      week: '2026-11-09',
      spentUsd: 95,
      weeklyUsd: 100,
      warnPercent: 90,
      settingId: 'org',
    })

    at = '2026-11-13T08:00:00.000Z'
    const later = await budgetItems('admin')
    expect(later[0]?.createdAt).toBe('2026-11-12T12:00:00.000Z')

    expect((await budgetItems('web-owner')).map((item) => item.id)).toEqual([
      'budget:web-cap:2026-11-09',
    ])
    expect(await budgetItems('web-ai')).toEqual([])
  })

  test('the default budget warns without a setting id and a new week starts clean', async () => {
    await store.aiUsage.append(run('acme/ledger-api', 30))
    const [item] = await budgetItems('admin')
    expect(item?.id).toBe('budget:default:2026-11-09')
    expect(item?.settingId).toBeUndefined()
    at = '2026-11-17T12:00:00.000Z'
    expect(await budgetItems('admin')).toEqual([])
  })

  test('nothing shows below the warning line', async () => {
    await budget('org', { all: true }, { weeklyUsd: 1000 })
    expect(await budgetItems('admin')).toEqual([])
  })
})
