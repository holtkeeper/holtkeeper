import { beforeEach, expect, test } from 'bun:test'

import type { SettingView } from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { createApp } from '../src/app.ts'

const config = parseConfig({
  forges: { work: { kind: 'fake', url: 'https://forge.test', create: () => ({}) as never } },
  groups: { web: { forge: 'work', include: ['acme/web-*'] } },
})

const auth = headerAuth({
  roles: {
    auditor: [
      { scope: { groups: ['web'] }, actions: ['audits:read', 'audits:run', 'settings:read'] },
    ],
    owner: [{ scope: { groups: ['web'] }, actions: ['settings:write'] }],
    other: [{ scope: { groups: ['pay'] }, actions: ['settings:write'] }],
  },
})
const as = (role: string) => ({ 'x-forwarded-user': role, 'x-forwarded-groups': role })

let store: Store
let app: ReturnType<typeof createApp>

const renew = (body: unknown, role: string) =>
  app.request('/api/audits/allowlist/renew', {
    method: 'POST',
    headers: { ...as(role), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

beforeEach(async () => {
  store = memoryStore()
  const vault = aesVault('v'.repeat(32))
  app = createApp({
    config,
    auth,
    store,
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: builtinSettings,
    analyses: [],
    now: () => new Date('2026-11-03T12:00:00.000Z'),
  })
  await store.settings.put({
    id: 'a-web',
    key: 'audit.allowlist',
    scope: { groups: ['web'] },
    value: [
      { id: 'GHSA-1', reason: 'Not reachable from widgets.', expires: '2026-11-05' },
      { id: 'GHSA-1', package: 'some-lib', reason: 'Waiting for 2.0.', expires: '2026-11-01' },
    ],
    secret: false,
    updatedAt: '2026-10-01T00:00:00.000Z',
  })
  await store.settings.put({
    id: 'fix-web',
    key: 'audit.fix',
    scope: { groups: ['web'] },
    value: true,
    secret: false,
    updatedAt: '2026-10-01T00:00:00.000Z',
  })
})

test('renewing needs settings:write on the setting scope and is audited', async () => {
  const body = {
    settingId: 'a-web',
    advisory: 'GHSA-1',
    package: 'some-lib',
    expires: '2026-12-01',
  }
  expect((await renew(body, 'auditor')).status).toBe(403)
  expect((await renew(body, 'other')).status).toBe(403)
  expect(
    (await store.audit.list({ action: 'allowlist.renew', outcome: 'denied' })).events,
  ).toHaveLength(2)

  const response = await renew(body, 'owner')
  expect(response.status).toBe(200)
  const view = (await response.json()) as SettingView
  expect(view).toMatchObject({ id: 'a-web', key: 'audit.allowlist', updatedBy: 'header:owner' })
  expect((await store.settings.get('a-web'))?.value).toEqual([
    { id: 'GHSA-1', reason: 'Not reachable from widgets.', expires: '2026-11-05' },
    { id: 'GHSA-1', package: 'some-lib', reason: 'Waiting for 2.0.', expires: '2026-12-01' },
  ])
  const [event] = (await store.audit.list({ action: 'allowlist.renew', outcome: 'ok' })).events
  expect(event?.target).toEqual({ type: 'setting', id: 'a-web' })
  expect(event?.changes).toEqual([{ field: 'expires', before: '2026-11-01', after: '2026-12-01' }])
  expect(event?.details).toMatchObject({ advisory: 'GHSA-1', package: 'some-lib' })
})

test('an entry without a package is matched only without one; last write wins', async () => {
  expect(
    (await renew({ settingId: 'a-web', advisory: 'GHSA-1', expires: '2026-11-20' }, 'owner'))
      .status,
  ).toBe(200)
  expect(
    (await renew({ settingId: 'a-web', advisory: 'GHSA-1', expires: '2026-11-25' }, 'owner'))
      .status,
  ).toBe(200)
  expect((await store.settings.get('a-web'))?.value).toEqual([
    { id: 'GHSA-1', reason: 'Not reachable from widgets.', expires: '2026-11-25' },
    { id: 'GHSA-1', package: 'some-lib', reason: 'Waiting for 2.0.', expires: '2026-11-01' },
  ])
})

test('refuses past dates, unknown entries and other settings', async () => {
  expect(
    (await renew({ settingId: 'a-web', advisory: 'GHSA-1', expires: '2026-11-02' }, 'owner'))
      .status,
  ).toBe(400)
  expect(
    (await renew({ settingId: 'a-web', advisory: 'GHSA-9', expires: '2026-12-01' }, 'owner'))
      .status,
  ).toBe(404)
  expect(
    (await renew({ settingId: 'fix-web', advisory: 'GHSA-1', expires: '2026-12-01' }, 'owner'))
      .status,
  ).toBe(404)
  expect(
    (await renew({ settingId: 'a-web', advisory: 'GHSA-1', expires: 'soon' }, 'owner')).status,
  ).toBe(400)
})
