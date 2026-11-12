import { beforeEach, describe, expect, test } from 'bun:test'

import type { CommitConventionsCheckResult, PolicyDraftResult, SettingView } from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { commitConventionsSetting } from '@holtkeeper/commit-conventions'
import type { ConventionsForge } from '@holtkeeper/commit-conventions'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { builtinSettings } from '@holtkeeper/settings'
import type { AuditEvent, Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { createApp } from '../src/app.ts'
import { summarizeChanges } from '../src/home.ts'

const forge: ConventionsForge = {
  getRepository: async (path) => ({
    path,
    name: path,
    defaultBranch: 'main',
    webUrl: '',
    cloneUrl: '',
    archived: false,
  }),
  readFile: async () => undefined,
  listFiles: async () => [],
  listCommits: async () => [],
  listBranches: async () => [],
  getPushRules: async () => undefined,
}

const config = parseConfig({
  forges: { work: { kind: 'fake', url: 'https://forge.test', create: () => forge as never } },
  groups: {
    web: { forge: 'work', include: ['acme/web-*'] },
    pay: { forge: 'work', include: ['acme/pay-*'] },
  },
})

const auth = headerAuth({
  roles: {
    admin: [{ scope: { all: true }, actions: ['settings:read', 'settings:write'] }],
    web: [
      { scope: { groups: ['web'] }, actions: ['settings:read', 'settings:write', 'analyses:read'] },
    ],
    pay: [{ scope: { groups: ['pay'] }, actions: ['analyses:read'] }],
  },
})
const as = (role: string) => ({ 'x-forwarded-user': role, 'x-forwarded-groups': role })

const today = '2026-11-12'
let store: Store
let app: ReturnType<typeof createApp>

const send = (method: string, path: string, body: unknown, role: string) =>
  app.request(path, {
    method,
    headers: { ...as(role), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const entry = (id: string, key: string, scope: object, value: unknown) =>
  store.settings.put({
    id,
    key,
    scope,
    value,
    secret: false,
    updatedAt: '2026-10-01T00:00:00.000Z',
  })

const allowlist = (expires: string | undefined, reason = 'Not reachable from widgets.') => [
  { id: 'GHSA-1', reason, ...(expires && { expires }) },
]

const put = (value: unknown, scope: object = { groups: ['web'] }) =>
  send('PUT', '/api/settings', { key: 'audit.allowlist', scope, value }, 'admin')

const renew = (body: object) =>
  send(
    'POST',
    '/api/audits/allowlist/renew',
    { settingId: 'a-web', advisory: 'GHSA-1', ...body },
    'admin',
  )

const check = (body: object, role = 'web') =>
  send('POST', '/api/commit-conventions/check', body, role)

beforeEach(() => {
  store = memoryStore()
  const vault = aesVault('v'.repeat(32))
  app = createApp({
    config,
    auth,
    store,
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: [...builtinSettings, commitConventionsSetting],
    analyses: [],
    now: () => new Date(`${today}T12:00:00.000Z`),
  })
})

describe('POST /api/settings/draft', () => {
  test('saves several keys at once and writes one audit event', async () => {
    await entry('fix-web', 'audit.fix', { groups: ['web'] }, false)
    await entry('upgrade-web', 'audit.upgrade', { groups: ['web'] }, 'minor')
    const response = await send(
      'POST',
      '/api/settings/draft',
      {
        changes: [
          { op: 'put', id: 'fix-web', key: 'audit.fix', scope: { groups: ['web'] }, value: true },
          {
            op: 'put',
            key: 'audit.allowlistPolicy',
            scope: { groups: ['web'] },
            value: { maxDays: 90, requireReason: true },
          },
          { op: 'remove', id: 'upgrade-web' },
        ],
      },
      'web',
    )
    expect(response.status).toBe(200)
    const result = (await response.json()) as PolicyDraftResult
    expect(result.saved.map((view: SettingView) => [view.key, view.value])).toEqual([
      ['audit.fix', true],
      ['audit.allowlistPolicy', { maxDays: 90, requireReason: true }],
    ])
    expect(result.removed).toEqual(['upgrade-web'])
    expect((await store.settings.get('fix-web'))?.value).toBe(true)
    expect(await store.settings.get('upgrade-web')).toBeUndefined()

    const { events } = await store.audit.list({ action: 'setting.draft' })
    expect(events).toHaveLength(1)
    const [event] = events
    expect(event?.outcome).toBe('ok')
    expect(event?.details).toEqual({
      keys: ['audit.fix', 'audit.allowlistPolicy', 'audit.upgrade'],
      saved: 2,
      removed: 1,
    })
    expect(event?.changes).toContainEqual({
      field: 'audit.fix#fix-web.value',
      before: false,
      after: true,
    })
    const [change] = summarizeChanges([event as AuditEvent], () => [])
    expect(change).toMatchObject({
      kind: 'settings',
      text: 'Saved 3 setting changes at once',
      href: '/settings/policies',
    })
  })

  test('stores nothing when one change is refused', async () => {
    await entry('fix-pay', 'audit.fix', { groups: ['pay'] }, false)
    const refused = await send(
      'POST',
      '/api/settings/draft',
      {
        changes: [
          { op: 'put', key: 'audit.fix', scope: { groups: ['web'] }, value: true },
          { op: 'remove', id: 'fix-pay' },
        ],
      },
      'web',
    )
    expect(refused.status).toBe(403)
    const invalid = await send(
      'POST',
      '/api/settings/draft',
      {
        changes: [
          { op: 'put', key: 'audit.fix', scope: { groups: ['web'] }, value: true },
          { op: 'put', key: 'audit.upgrade', scope: { groups: ['web'] }, value: 'huge' },
        ],
      },
      'web',
    )
    expect(invalid.status).toBe(400)
    expect((await store.settings.list()).map((stored) => stored.id)).toEqual(['fix-pay'])
    expect(
      (await store.audit.list({ action: 'setting.draft', outcome: 'denied' })).events,
    ).toHaveLength(1)
  })

  test('refuses changing one entry twice and unknown keys', async () => {
    await entry('fix-web', 'audit.fix', { groups: ['web'] }, false)
    const twice = await send(
      'POST',
      '/api/settings/draft',
      {
        changes: [
          { op: 'put', id: 'fix-web', key: 'audit.fix', scope: { groups: ['web'] }, value: true },
          { op: 'remove', id: 'fix-web' },
        ],
      },
      'web',
    )
    expect(twice.status).toBe(400)
    const unknown = await send(
      'POST',
      '/api/settings/draft',
      { changes: [{ op: 'put', key: 'widget.size', scope: { all: true }, value: 1 }] },
      'admin',
    )
    expect(unknown.status).toBe(400)
  })
})

describe('allowlist rules', () => {
  beforeEach(async () => {
    await entry(
      'policy-web',
      'audit.allowlistPolicy',
      { groups: ['web'] },
      {
        maxDays: 30,
        requireReason: true,
      },
    )
  })

  test('PUT refuses new entries past maxDays or without an expiry', async () => {
    const late = await put(allowlist('2027-01-01'))
    expect(late.status).toBe(400)
    expect(await late.text()).toContain('must expire by 2026-12-12')
    expect((await put(allowlist(undefined))).status).toBe(400)
    expect((await put(allowlist('2026-12-01', '   '))).status).toBe(400)
    expect((await put(allowlist('2026-12-01'))).status).toBe(200)
    expect((await put(allowlist(undefined), { groups: ['pay'] })).status).toBe(200)
  })

  test('entries already stored pass unchanged; a draft checks against its own policy', async () => {
    await entry('a-web', 'audit.allowlist', { groups: ['web'] }, allowlist('2027-06-01'))
    const keep = await send(
      'PUT',
      '/api/settings',
      {
        id: 'a-web',
        key: 'audit.allowlist',
        scope: { groups: ['web'] },
        value: [
          ...allowlist('2027-06-01'),
          { id: 'GHSA-2', reason: 'Dev only.', expires: '2026-11-20' },
        ],
      },
      'admin',
    )
    expect(keep.status).toBe(200)

    const draft = await send(
      'POST',
      '/api/settings/draft',
      {
        changes: [
          {
            op: 'put',
            id: 'policy-web',
            key: 'audit.allowlistPolicy',
            scope: { groups: ['web'] },
            value: { maxDays: 365, requireReason: true },
          },
          {
            op: 'put',
            key: 'audit.allowlist',
            scope: { groups: ['web'] },
            value: [{ id: 'GHSA-3', reason: 'Fixed upstream soon.', expires: '2027-03-01' }],
          },
        ],
      },
      'admin',
    )
    expect(draft.status).toBe(200)
  })

  test('a narrower policy cannot loosen a wider one', async () => {
    await store.settings.remove('policy-web')
    await entry('policy-org', 'audit.allowlistPolicy', { all: true }, { maxDays: 30 })
    const loose = await send(
      'PUT',
      '/api/settings',
      {
        key: 'audit.allowlistPolicy',
        scope: { groups: ['web'] },
        value: { requireReason: false },
      },
      'web',
    )
    expect(loose.status).toBe(200)
    const late = await send(
      'PUT',
      '/api/settings',
      { key: 'audit.allowlist', scope: { groups: ['web'] }, value: allowlist('2027-02-10') },
      'web',
    )
    expect(late.status).toBe(400)
    const drafted = await send(
      'POST',
      '/api/settings/draft',
      {
        changes: [
          {
            op: 'put',
            key: 'audit.allowlistPolicy',
            scope: { groups: ['web'] },
            value: { maxDays: 365, requireReason: false },
          },
          {
            op: 'put',
            key: 'audit.allowlist',
            scope: { groups: ['web'] },
            value: allowlist('2027-02-10'),
          },
        ],
      },
      'web',
    )
    expect(drafted.status).toBe(400)
  })

  test('renew keeps to maxDays and may replace the reason', async () => {
    await entry('a-web', 'audit.allowlist', { groups: ['web'] }, allowlist('2026-11-20'))
    const late = await renew({ expires: '2027-02-01' })
    expect(late.status).toBe(400)
    expect(await late.text()).toContain('at most 30 days')
    const ok = await renew({ expires: '2026-12-10', reason: 'Still waiting for 2.0.' })
    expect(ok.status).toBe(200)
    expect((await store.settings.get('a-web'))?.value).toEqual([
      { id: 'GHSA-1', reason: 'Still waiting for 2.0.', expires: '2026-12-10' },
    ])
  })
})

describe('POST /api/commit-conventions/check', () => {
  beforeEach(async () => {
    await entry(
      'conventions',
      'commits.conventions',
      { all: true },
      {
        commit: { conventional: true, types: ['feat', 'fix'], ticket: { pattern: 'ABC-\\d+' } },
        branch: { prefixes: ['feature'] },
      },
    )
  })

  test('reports the rules a message and a branch break, as check_commit_message does', async () => {
    const response = await check({
      repo: 'work:acme/web-shop',
      message: 'chore: update stuff',
      branch: 'widget-board',
    })
    expect(response.status).toBe(200)
    const result = (await response.json()) as CommitConventionsCheckResult
    expect(result.ok).toBe(false)
    expect(
      result.problems.map((problem) => [problem.target, problem.rule, problem.severity]),
    ).toEqual([
      ['message', 'types', 'error'],
      ['message', 'ticket', 'error'],
      ['branch', 'prefixes', 'error'],
    ])
    const passes = (await (
      await check({ repo: 'work:acme/web-shop', message: 'feat(cart): [ABC-123] add the summary' })
    ).json()) as CommitConventionsCheckResult
    expect(passes).toEqual({ ok: true, problems: [] })
  })

  test('needs analyses:read on the repository and something to check', async () => {
    expect((await check({ repo: 'work:acme/web-shop', message: 'x' }, 'pay')).status).toBe(403)
    expect((await check({ repo: 'work:acme/web-shop' })).status).toBe(400)
    expect((await check({ repo: 'nope', message: 'x' })).status).toBe(400)
  })
})
