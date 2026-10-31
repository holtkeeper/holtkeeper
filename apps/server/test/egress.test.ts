import { afterAll, beforeEach, describe, expect, test } from 'bun:test'

import type { EgressCacheView, EgressRule, EgressRulesResponse } from '@holtkeeper/api'
import { noAuth } from '@holtkeeper/auth-none'
import { type HoltkeeperConfig, parseConfig } from '@holtkeeper/core'
import { type CredentialService, createCredentialService } from '@holtkeeper/credentials'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { createApp } from '../src/app.ts'
import { validateEgressSecretOptions } from '../src/egress-secrets.ts'

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

const putForge = (id: string, url: string, packages?: boolean, cachePackages?: boolean) =>
  store.config?.put({
    type: 'forge',
    id,
    updatedAt: '2026-10-30T12:00:00.000Z',
    data: {
      kind: 'gitlab',
      url,
      credentialId: tokenId,
      ...(packages !== undefined && { packages }),
      ...(cachePackages !== undefined && { cachePackages }),
    },
  })

const rules = (app: ReturnType<typeof appWith>, authorization?: string) =>
  app.request('/api/egress/rules', {
    headers: authorization ? { authorization } : {},
  })

beforeEach(async () => {
  store = memoryStore()
  credentials = createCredentialService({
    credentials: store.credentials,
    vault,
    validateOptions: validateEgressSecretOptions,
  })
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
  await putForge('cloud', 'https://gitlab.com')
  await putForge('other', 'https://other.test', false)
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

  test('covers GitLab forges unless packages are off, with the current token', async () => {
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
    expect(next.rules[0]?.headers?.Authorization).toBe('Bearer glpat-rotated')
  })

  test('adds a private cache rule for the package files of forges that cache packages', async () => {
    const app = appWith({ egress: { secret } })
    const plain = (await (await rules(app, `Bearer ${secret}`)).json()) as EgressRulesResponse
    expect(plain.cache).toBeUndefined()
    await putForge('cloud', 'https://gitlab.com', undefined, true)
    await putForge('other', 'https://other.test', false, true)
    const cached = (await (await rules(app, `Bearer ${secret}`)).json()) as EgressRulesResponse
    expect(cached.cache).toHaveLength(1)
    expect(cached.cache?.[0]).toMatchObject({ kind: 'packages', host: 'gitlab.com', private: true })
    expect(cached.cache?.[0]?.paths.some((path) => path.includes('/npm/'))).toBe(true)
  })

  test('leaves out forges whose credential is gone', async () => {
    await credentials.remove(tokenId, 'root')
    const body = (await (
      await rules(appWith({ egress: { secret } }), `Bearer ${secret}`)
    ).json()) as EgressRulesResponse
    expect(body.rules).toEqual([])
  })

  test('turns egress secrets into placeholder replacements per host', async () => {
    await credentials.remove(tokenId, 'root')
    const placeholder = '6c1d7c9e-3a51-4b8e-9f0a-2d5e8b7c4f10'
    const created = await credentials.create(
      {
        name: 'Turbo cache',
        kind: 'egress-secret',
        url: 'http://turbo-cache.internal',
        scope: { all: true },
        secret: 'turbo-token',
        options: { placeholder, hosts: ['*.turbo.example'] },
      },
      'root',
    )
    const body = (await (
      await rules(appWith({ egress: { secret } }), `Bearer ${secret}`)
    ).json()) as EgressRulesResponse
    const replacement: Omit<EgressRule, 'host'> = {
      methods: ['*'],
      replace: { [placeholder]: 'turbo-token' },
      in: ['headers'],
      insecure: true,
    }
    expect(body.rules).toEqual([
      { host: 'turbo-cache.internal', ...replacement },
      { host: '*.turbo.example', ...replacement },
    ])
    const refused = await credentials
      .update(created.id, { options: { placeholder: 'short' } }, 'root')
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    expect(String(refused)).toContain('placeholder')
  })
})

describe('egress cache', () => {
  const seen: { method: string; url: string; authorization: string | null; body: string }[] = []
  const snapshot = {
    backend: { kind: 'dir', location: '/cache' },
    ttlSeconds: { packages: 2_419_200, tools: 1_814_400 },
    maxBytes: null,
    maxEntryBytes: 4_294_967_296,
    since: '2026-10-30T11:00:00Z',
    syncedAt: null,
    stats: { hits: 1, misses: 2, stored: 2, servedBytes: 10, errors: 0 },
    rules: [{ kind: 'packages', host: 'registry.npmjs.org', paths: ['\\.tgz$'], private: false }],
    total: { count: 1, bytes: 10 },
    entries: [
      {
        path: 'packages/registry.npmjs.org/a/-/a-1.0.0.tgz',
        url: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz',
        kind: 'packages',
        size: 10,
        hits: 1,
        storedAt: '2026-10-30T11:00:00Z',
        lastUsedAt: '2026-10-30T11:30:00Z',
        expiresAt: '2026-11-27T11:30:00Z',
        expired: false,
      },
    ],
  }
  const proxy = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      seen.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.get('authorization'),
        body: await request.text(),
      })
      if (request.headers.get('authorization') !== `Bearer ${secret}`)
        return Response.json({ error: 'unauthorized' }, { status: 401 })
      return new URL(request.url).pathname === '/v1/cache/delete'
        ? Response.json({ removed: 2, bytes: 10 })
        : Response.json(snapshot)
    },
  })
  const proxyUrl = `http://127.0.0.1:${proxy.port}`
  afterAll(() => proxy.stop(true))

  test('says when no proxy is configured', async () => {
    const response = await appWith({ egress: { secret } }).request('/api/egress/cache')
    expect((await response.json()) as EgressCacheView).toEqual({ configured: false })
  })

  test('reads the cache through the proxy with the egress secret', async () => {
    const response = await appWith({ egress: { secret, proxy: proxyUrl } }).request(
      '/api/egress/cache',
    )
    expect(await response.json()).toEqual({ configured: true, ...snapshot })
    expect(seen.at(-1)).toMatchObject({
      method: 'GET',
      url: 'http://egress-cache.invalid/v1/cache',
      authorization: `Bearer ${secret}`,
    })
  })

  test('reports a proxy that refuses the secret instead of failing', async () => {
    const response = await appWith({ egress: { secret: 'other', proxy: proxyUrl } }).request(
      '/api/egress/cache',
    )
    expect(await response.json()).toEqual({
      configured: true,
      error: 'the proxy refused the egress secret',
    })
  })

  test('deletes entries and records who did', async () => {
    const response = await appWith({ egress: { secret, proxy: proxyUrl } }).request(
      '/api/egress/cache/delete',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'tools' }),
      },
    )
    expect(await response.json()).toEqual({ removed: 2, bytes: 10 })
    expect(JSON.parse(seen.at(-1)?.body ?? '{}')).toEqual({ kind: 'tools' })
    const [entry] = await store.activity.list({ limit: 1 })
    expect(entry).toMatchObject({ action: 'egress-cache.cleared', subject: 'tools' })
  })
})
