import { beforeEach, describe, expect, test } from 'bun:test'

import type { ForgeAccountView } from '@holtkeeper/api'
import { noAuth } from '@holtkeeper/auth-none'
import { parseConfigFile } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import type { AccountAvatarFile, ForgeUser, GitForge } from '@holtkeeper/forge'
import { createConfigSource, liveConfig } from '@holtkeeper/managed-config'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'
import { z } from 'zod'

import { createApp } from '../src/app.ts'

const vault = aesVault('v'.repeat(32))
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

let store: Store
let app: ReturnType<typeof createApp>
let uploads: AccountAvatarFile[]
let avatarUrl: string
let rejectUpload: Error | undefined

const user = (): ForgeUser => ({
  username: 'widget-bot',
  name: 'Widget Bot',
  avatarUrl,
  webUrl: 'https://forge.test/widget-bot',
  settingsUrl: 'https://forge.test/-/user_settings/profile',
})

const avatarForge = {
  kind: 'gitlab',
  getCurrentUser: async () => user(),
  async setCurrentUserAvatar(file: AccountAvatarFile) {
    if (rejectUpload) throw rejectUpload
    uploads.push(file)
    avatarUrl = 'https://forge.test/uploads/avatar-2.png'
  },
} as unknown as GitForge

const plainForge = { kind: 'gitlab', getCurrentUser: async () => user() } as unknown as GitForge

beforeEach(async () => {
  store = memoryStore()
  uploads = []
  avatarUrl = 'https://forge.test/uploads/avatar-1.png'
  rejectUpload = undefined
  const credentials = createCredentialService({ credentials: store.credentials, vault })
  const { id: credentialId } = await credentials.create({
    name: 'bot',
    kind: 'gitlab',
    url: 'https://forge.test',
    scope: { all: true },
    secret: 'tok',
  })
  if (!store.config) throw new Error('memory store has config')
  for (const id of ['main', 'plain'])
    // oxlint-disable-next-line no-await-in-loop -- two documents, order does not matter
    await store.config.put({
      type: 'forge',
      id,
      updatedAt: '2026-10-30T00:00:00.000Z',
      data: { kind: 'gitlab', url: 'https://forge.test', credentialId },
    })
  const source = await createConfigSource({
    file: parseConfigFile({}, { warn: () => {} }),
    store: store.config,
    forgeFactories: {
      gitlab: (doc) => ({
        kind: 'gitlab',
        url: doc.data.url,
        create: () => (doc.id === 'plain' ? plainForge : avatarForge),
      }),
    },
    revealToken: (id) => credentials.reveal(id),
    openSecret: (sealed) => vault.open(sealed),
  })
  app = createApp({
    config: liveConfig(source),
    configSource: source,
    auth: noAuth(),
    store,
    vault,
    credentials,
    settings: builtinSettings,
    analyses: [],
    analyzers: [{ kind: 'snapshot', scope: 'repo', options: z.object({}) }],
    now: () => new Date('2026-10-30T12:00:00.000Z'),
  })
})

const upload = (forge: string, filename: string | undefined, body: Uint8Array) =>
  app.request(
    `/api/forges/${forge}/account/avatar${filename === undefined ? '' : `?filename=${encodeURIComponent(filename)}`}`,
    { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body },
  )

const messageOf = async (response: Response) =>
  (await response.json()) as { error?: string; message?: string }

describe('forge account', () => {
  test('reads the token account with its links', async () => {
    const response = await app.request('/api/forges/main/account')
    expect(response.status).toBe(200)
    expect((await response.json()) as ForgeAccountView).toEqual({
      ...user(),
      canSetAvatar: true,
    })
    const plain = (await (
      await app.request('/api/forges/plain/account')
    ).json()) as ForgeAccountView
    expect(plain.canSetAvatar).toBe(false)
    expect((await app.request('/api/forges/missing/account')).status).toBe(409)
  })

  test('uploads a valid avatar under a neutral name, audits it and answers the new account', async () => {
    const response = await upload('main', 'My Face.PNG', png)
    expect(response.status).toBe(200)
    expect(((await response.json()) as ForgeAccountView).avatarUrl).toBe(
      'https://forge.test/uploads/avatar-2.png',
    )
    expect(uploads).toEqual([{ bytes: png, filename: 'avatar.png', contentType: 'image/png' }])
    const events = (await store.audit.list({ limit: 50 })).events
    expect(events.find((event) => event.action === 'forge.avatar_set')).toMatchObject({
      target: { type: 'forge', id: 'main' },
      details: { contentType: 'image/png', bytes: png.byteLength },
    })
  })

  test('rejects files that are too large or not an accepted image', async () => {
    const big = new Uint8Array(200 * 1024 + 1)
    big.set(png)
    const tooLarge = await upload('main', 'face.png', big)
    expect(tooLarge.status).toBe(400)
    expect(JSON.stringify(await messageOf(tooLarge))).toContain('larger than 200 KB')
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')
    expect((await upload('main', 'face.svg', svg)).status).toBe(400)
    const disguised = await upload('main', 'face.jpg', png)
    expect(disguised.status).toBe(400)
    expect(JSON.stringify(await messageOf(disguised))).toContain('not the image its name says')
    expect((await upload('main', undefined, png)).status).toBe(400)
    expect(uploads).toEqual([])
  })

  test('409 when the forge cannot change avatars', async () => {
    expect((await upload('plain', 'face.png', png)).status).toBe(409)
  })

  test('forge rejections become 400 for bad files and 502 otherwise', async () => {
    rejectUpload = Object.assign(new Error('avatar is invalid'), { status: 400 })
    expect((await upload('main', 'face.png', png)).status).toBe(400)
    rejectUpload = new Error('socket hang up')
    expect((await upload('main', 'face.png', png)).status).toBe(502)
    const events = (await store.audit.list({ limit: 50 })).events
    expect(events.some((event) => event.action === 'forge.avatar_set')).toBe(false)
  })
})
