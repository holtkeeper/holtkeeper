import { beforeEach, describe, expect, test } from 'bun:test'

import type { RepoAvatarInfo } from '@holtkeeper/api'
import { type ArtifactStore, memoryArtifactStore } from '@holtkeeper/artifacts'
import { headerAuth } from '@holtkeeper/auth-header'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { createApp } from '../src/app.ts'

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
let forgeAvatar: Uint8Array | undefined
let forgeCalls = 0
let forgeGate: Promise<void> | undefined

const config = parseConfig({
  forges: {
    work: {
      kind: 'gitlab',
      url: 'https://gitlab.test',
      create: () =>
        ({
          getRepositoryAvatar: async () => {
            forgeCalls++
            await forgeGate
            return forgeAvatar ? { data: forgeAvatar, contentType: 'image/png' } : undefined
          },
        }) as never,
    },
  },
  groups: { games: { forge: 'work', include: ['games/*'] } },
})

const auth = headerAuth({
  roles: {
    admin: [{ scope: { all: true }, actions: ['repos:read', 'settings:write'] }],
    reader: [{ scope: { all: true }, actions: ['repos:read'] }],
  },
})
const asAdmin = { 'x-forwarded-user': 'jane', 'x-forwarded-groups': 'admin' }
const asReader = { 'x-forwarded-user': 'bob', 'x-forwarded-groups': 'reader' }

let store: Store
let artifacts: ArtifactStore
let clock = new Date('2026-10-30T12:00:00.000Z')
const build = () => {
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
    artifacts,
    now: () => clock,
  })
}
let app: ReturnType<typeof createApp>
const avatar = '/api/repos/avatar?repo=work:games/data-tools'

beforeEach(() => {
  store = memoryStore()
  forgeAvatar = undefined
  forgeCalls = 0
  forgeGate = undefined
  clock = new Date('2026-10-30T12:00:00.000Z')
  artifacts = memoryArtifactStore()
  app = build()
})

const info = async () =>
  (await (
    await app.request(`/api/repos/avatar/info?repo=work:games/data-tools`, { headers: asReader })
  ).json()) as RepoAvatarInfo

const put = (headers: Record<string, string>, body: Uint8Array | string) =>
  app.request(avatar, { method: 'PUT', headers, body })

describe('repository avatars', () => {
  test('a new process serves the stored forge avatar and refreshes it when stale', async () => {
    forgeAvatar = png
    expect((await app.request(avatar, { headers: asReader })).headers.get('content-type')).toBe(
      'image/png',
    )
    expect(forgeCalls).toBe(1)

    forgeAvatar = undefined
    app = build()
    expect((await app.request(avatar, { headers: asReader })).headers.get('content-type')).toBe(
      'image/png',
    )
    expect(forgeCalls).toBe(1)

    clock = new Date(Date.now() + 7 * 60 * 60 * 1000)
    app = build()
    expect((await app.request(avatar, { headers: asReader })).headers.get('content-type')).toBe(
      'image/png',
    )
    await Bun.sleep(0)
    expect(forgeCalls).toBe(2)
    expect((await app.request(avatar, { headers: asReader })).headers.get('content-type')).toBe(
      'image/svg+xml',
    )
  })

  test('a slow forge is asked once and does not hold up the page', async () => {
    const gate = Promise.withResolvers<void>()
    forgeGate = gate.promise
    forgeAvatar = png
    const responses = await Promise.all(
      [1, 2, 3].map(async () => app.request(avatar, { headers: asReader })),
    )
    expect(responses.map((response) => response.headers.get('content-type'))).toEqual([
      'image/svg+xml',
      'image/svg+xml',
      'image/svg+xml',
    ])
    expect(forgeCalls).toBe(1)
    gate.resolve()
    await gate.promise
    await Bun.sleep(0)
    const ready = await app.request(avatar, { headers: asReader })
    expect(ready.headers.get('content-type')).toBe('image/png')
    expect(forgeCalls).toBe(1)
  })

  test('generated, then the forge avatar, then an upload; reset falls back', async () => {
    const generated = await app.request(avatar, { headers: asReader })
    expect(generated.headers.get('content-type')).toBe('image/svg+xml')
    expect(await generated.text()).toContain('>GD</text>')
    expect((await info()).source).toBe('generated')

    const etag = generated.headers.get('etag') ?? ''
    const again = await app.request(avatar, { headers: { ...asReader, 'If-None-Match': etag } })
    expect(again.status).toBe(304)
    expect(forgeCalls).toBe(1)

    const upload = await app.request(avatar, {
      method: 'PUT',
      headers: { ...asAdmin, 'content-type': 'image/png' },
      body: png,
    })
    expect(upload.status).toBe(200)
    const custom = await app.request(avatar, { headers: asReader })
    expect(custom.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await custom.arrayBuffer())).toEqual(png)
    expect(await info()).toMatchObject({ source: 'custom', updatedBy: 'header:jane' })

    expect((await app.request(avatar, { method: 'DELETE', headers: asAdmin })).status).toBe(204)
    expect((await info()).source).toBe('generated')
  })

  test('uses the forge avatar when there is one', async () => {
    forgeAvatar = png
    const response = await app.request(avatar, { headers: asReader })
    expect(response.headers.get('content-type')).toBe('image/png')
    expect((await info()).source).toBe('forge')
  })

  test('uploads need settings:write and a real raster image', async () => {
    expect((await put(asReader, png)).status).toBe(403)
    expect((await put(asAdmin, '<svg xmlns="x"><script/></svg>')).status).toBe(415)
    expect((await put(asAdmin, new Uint8Array(600 * 1024).fill(0x89))).status).toBe(413)
  })
})
