import { beforeEach, describe, expect, test } from 'bun:test'

import type { EgressRulesResponse } from '@holtkeeper/api'
import { noAuth } from '@holtkeeper/auth-none'
import { type HoltkeeperConfig, parseConfig } from '@holtkeeper/core'
import { type CredentialService, createCredentialService } from '@holtkeeper/credentials'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { createApp } from '../src/app.ts'

const vault = aesVault('v'.repeat(32))
const secret = 'egress-secret'

let store: Store
let credentials: CredentialService
let tokenId: string

const appWith = (server?: Partial<NonNullable<HoltkeeperConfig['server']>>) =>
  createApp({
    config: { ...parseConfig({ forges: {} }), ...(server && { server }) } as HoltkeeperConfig,
    auth: noAuth(),
    store,
    vault,
    credentials,
    settings: builtinSettings,
    analyses: [],
    analyzers: [],
    now: () => new Date('2026-10-30T12:00:00.000Z'),
  })

const putForge = (id: string, url: string, packages?: boolean) =>
  store.config?.put({
    type: 'forge',
    id,
    updatedAt: '2026-10-30T12:00:00.000Z',
    data: { kind: 'gitlab', url, credentialId: tokenId, ...(packages && { packages }) },
  })

const rules = (app: ReturnType<typeof appWith>, authorization?: string) =>
  app.request('/api/egress/rules', {
    headers: authorization ? { authorization } : {},
  })

beforeEach(async () => {
  store = memoryStore()
  credentials = createCredentialService({ credentials: store.credentials, vault })
  tokenId = (
    await credentials.create(
      {
        name: 'Hamster',
        kind: 'gitlab',
        url: 'https://gitlab.com',
        scope: { all: true },
        secret: 'glpat-first',
      },
      'root',
    )
  ).id
  await putForge('cloud', 'https://gitlab.com', true)
  await putForge('other', 'https://other.test')
})

describe('egress rules', () => {
  test('is not served without server.egress', async () => {
    expect((await rules(appWith(), `Bearer ${secret}`)).status).toBe(404)
  })

  test('needs the egress secret, not a session', async () => {
    const app = appWith({ egress: { secret } })
    expect((await rules(app)).status).toBe(401)
    expect((await rules(app, 'Bearer wrong')).status).toBe(401)
    expect((await rules(app, `Bearer ${secret}`)).status).toBe(200)
  })

  test('covers forges with packages on, with the current token', async () => {
    const app = appWith({ egress: { secret } })
    const response = await rules(app, `Bearer ${secret}`)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(((await response.json()) as EgressRulesResponse).rules).toEqual([
      {
        host: 'gitlab.com',
        paths: ['^/api/v4/(projects/[^/]+/|groups/[^/]+/(-/)?)?packages/'],
        methods: ['GET', 'HEAD'],
        headers: { Authorization: 'Bearer glpat-first' },
      },
    ])
    await credentials.update(tokenId, { secret: 'glpat-rotated' }, 'root')
    const next = (await (await rules(app, `Bearer ${secret}`)).json()) as EgressRulesResponse
    expect(next.rules[0]?.headers.Authorization).toBe('Bearer glpat-rotated')
  })

  test('leaves out forges whose credential is gone', async () => {
    await credentials.remove(tokenId, 'root')
    const body = (await (
      await rules(appWith({ egress: { secret } }), `Bearer ${secret}`)
    ).json()) as EgressRulesResponse
    expect(body.rules).toEqual([])
  })
})
