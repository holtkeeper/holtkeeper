import { beforeEach, expect, test } from 'bun:test'

import type { SnoozeList } from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { createApp } from '../src/app.ts'
import { failureSnoozeId, snoozedIds } from '../src/snoozes.ts'

const auth = headerAuth({ roles: { member: [{ scope: { all: true }, actions: ['repos:read'] }] } })
const as = (user: string) => ({ 'x-forwarded-user': user, 'x-forwarded-groups': 'member' })

let store: Store
let clock: number
let app: ReturnType<typeof createApp>

const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  app.request(`/api${path}`, {
    method,
    headers: { ...headers, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

const listOf = async (response: Response) => ((await response.json()) as SnoozeList).snoozes

beforeEach(() => {
  store = memoryStore()
  clock = Date.parse('2026-11-03T12:00:00.000Z')
  const vault = aesVault('v'.repeat(32))
  app = createApp({
    config: parseConfig({}),
    auth,
    store,
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: builtinSettings,
    analyses: [],
    now: () => new Date(clock),
  })
})

test('snoozes are personal, replace earlier ones, run out and are not audited', async () => {
  const added = await call('POST', '/me/snoozes', as('ana'), {
    id: 'task:g-1',
    until: '2026-11-05T00:00:00.000Z',
  })
  expect(added.status).toBe(200)
  await call('POST', '/me/snoozes', as('ana'), {
    id: 'job-failures:widgets:timeout',
    until: '2026-11-04T00:00:00+02:00',
  })
  const replaced = await call('POST', '/me/snoozes', as('ana'), {
    id: 'task:g-1',
    until: '2026-11-06T00:00:00.000Z',
  })
  expect(await listOf(replaced)).toEqual([
    { id: 'job-failures:widgets:timeout', until: '2026-11-03T22:00:00.000Z' },
    { id: 'task:g-1', until: '2026-11-06T00:00:00.000Z' },
  ])
  expect(await listOf(await call('GET', '/me/snoozes', as('teo')))).toEqual([])

  clock = Date.parse('2026-11-04T00:00:00.000Z')
  expect(await listOf(await call('GET', '/me/snoozes', as('ana')))).toEqual([
    { id: 'task:g-1', until: '2026-11-06T00:00:00.000Z' },
  ])
  expect(await snoozedIds(store.kv, 'header:ana', new Date(clock))).toEqual(new Set(['task:g-1']))

  const removed = await call('DELETE', '/me/snoozes?id=task%3Ag-1', as('ana'))
  expect(removed.status).toBe(200)
  expect(await listOf(removed)).toEqual([])
  expect(await store.audit.count({})).toBe(0)
})

test('refuses past times, missing ids and anonymous callers', async () => {
  expect(
    (await call('POST', '/me/snoozes', as('ana'), { id: 'x', until: '2026-11-03T11:00:00.000Z' }))
      .status,
  ).toBe(400)
  expect(
    (await call('POST', '/me/snoozes', as('ana'), { id: '', until: '2026-11-04T00:00:00.000Z' }))
      .status,
  ).toBe(400)
  expect((await call('DELETE', '/me/snoozes', as('ana'))).status).toBe(400)
  expect(
    (await call('POST', '/me/snoozes', {}, { id: 'x', until: '2026-11-04T00:00:00.000Z' })).status,
  ).toBe(401)
})

test('job failures are named by signature, else by repository', () => {
  expect(failureSnoozeId({ analyzer: 'widgets', signature: 'timeout', repo: 'work:acme/a' })).toBe(
    'job-failures:widgets:timeout',
  )
  expect(failureSnoozeId({ analyzer: 'widgets', repo: 'work:acme/a' })).toBe(
    'job-failures:widgets:work:acme/a',
  )
})
