import { expect, test } from 'bun:test'

import type { MeResponse } from '@holtkeeper/api'
import { noAuth } from '@holtkeeper/auth-none'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { builtinSettings } from '@holtkeeper/settings'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { createApp } from '../src/app.ts'

const setup = (options: { version?: string; publicUrl?: string }) => {
  const store = memoryStore()
  const vault = aesVault('v'.repeat(32))
  return createApp({
    config: options.publicUrl
      ? parseConfig({
          server: { auth: noAuth(), store, vaultKey: 'v'.repeat(32), publicUrl: options.publicUrl },
        })
      : parseConfig({}),
    auth: noAuth(),
    store,
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: builtinSettings,
    analyses: [],
    ...(options.version !== undefined && { version: options.version }),
    now: () => new Date('2026-11-12T12:00:00.000Z'),
  })
}

const me = async (app: ReturnType<typeof setup>) =>
  (await (await app.request('/api/me')).json()) as MeResponse

test('/api/me reports the running version and the configured public URL', async () => {
  const body = await me(setup({ version: ' 1.4.0 ', publicUrl: 'https://holtkeeper.acme.test/' }))
  expect(body.version).toBe('1.4.0')
  expect(body.publicUrl).toBe('https://holtkeeper.acme.test')
})

test('/api/me leaves version and public URL out when neither is known', async () => {
  const previous = Bun.env.HOLTKEEPER_VERSION
  delete Bun.env.HOLTKEEPER_VERSION
  try {
    const body = await me(setup({ version: '' }))
    expect(body).not.toHaveProperty('version')
    expect(body).not.toHaveProperty('publicUrl')
  } finally {
    if (previous !== undefined) Bun.env.HOLTKEEPER_VERSION = previous
  }
})
