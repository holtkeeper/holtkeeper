import { beforeEach, describe, expect, test } from 'bun:test'

import type { ConfigEntryList, ForgeSshKeyResult } from '@holtkeeper/api'
import { noAuth } from '@holtkeeper/auth-none'
import { parseConfig } from '@holtkeeper/core'
import { type CredentialService, createCredentialService } from '@holtkeeper/credentials'
import { createFakeRunner } from '@holtkeeper/exec/testing'
import type { GitForge, SshKeyRegistration } from '@holtkeeper/forge'
import { createConfigSource, liveConfig } from '@holtkeeper/managed-config'
import { builtinSettings } from '@holtkeeper/settings'
import {
  generateKeyPair,
  parsePrivateKey,
  validateSshCredentialOptions,
} from '@holtkeeper/ssh-keys'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { createApp } from '../src/app.ts'
import { forgeGitKeys } from '../src/ssh-keys.ts'

const vault = aesVault('v'.repeat(32))
const hostKey = generateKeyPair({ type: 'ed25519' })
const file = parseConfig({
  forges: {
    work: { kind: 'gitlab', url: 'https://file.test', create: () => ({}) as GitForge },
  },
  groups: {},
})

let store: Store
let credentials: CredentialService
let tokenId: string
let keys: Map<string, SshKeyRegistration>
let nextKeyId: number
let keyscanFails: boolean
let app: ReturnType<typeof createApp>

const forge = {
  kind: 'gitlab',
  async getCurrentUser() {
    return { username: 'bot', name: 'Holtkeeper Bot', email: 'bot@gitlab.test' }
  },
  async registerSshKey(key: SshKeyRegistration) {
    const id = String(nextKeyId++)
    keys.set(id, key)
    return { id }
  },
  async removeSshKey(id: string) {
    if (!keys.delete(id)) throw new Error(`no key ${id}`)
  },
} as unknown as GitForge

beforeEach(async () => {
  store = memoryStore()
  keys = new Map()
  nextKeyId = 1
  keyscanFails = false
  credentials = createCredentialService({
    credentials: store.credentials,
    activity: store.activity,
    vault,
    validateOptions: validateSshCredentialOptions,
  })
  tokenId = (
    await credentials.create(
      {
        name: 'cloud',
        kind: 'gitlab',
        url: 'https://gitlab.test',
        scope: { all: true },
        secret: 'tok',
      },
      'root',
    )
  ).id
  if (!store.config) throw new Error('memory store has config')
  const source = await createConfigSource({
    file,
    store: store.config,
    forgeFactories: {
      gitlab: (doc) => ({ kind: 'gitlab', url: doc.data.url, create: () => forge }),
    },
    revealToken: (id) => credentials.reveal(id),
  })
  const { runner } = createFakeRunner((command) =>
    command[0] === 'ssh-keyscan'
      ? keyscanFails
        ? { exitCode: 1, stderr: 'connection refused' }
        : { stdout: `gitlab.test ${hostKey.publicKey}\n` }
      : undefined,
  )
  app = createApp({
    config: liveConfig(source),
    configSource: source,
    auth: noAuth(),
    store,
    vault,
    credentials,
    settings: builtinSettings,
    analyses: [],
    analyzers: [],
    hostRunner: runner,
    now: () => new Date('2026-10-30T12:00:00.000Z'),
  })
})

const call = (method: string, path: string, body?: unknown) =>
  app.request(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })

const putForge = () =>
  call('PUT', '/config/forges/cloud', {
    kind: 'gitlab',
    url: 'https://gitlab.test',
    credentialId: tokenId,
  })

const issue = async (body: unknown = {}) => {
  const response = await call('POST', '/forges/cloud/ssh-key', body)
  expect(response.status).toBe(201)
  return (await response.json()) as ForgeSshKeyResult
}

describe('forge SSH keys', () => {
  test('issue registers a user key, pins host keys and stores a credential', async () => {
    expect((await call('POST', '/forges/work/ssh-key', {})).status).toBe(409)
    expect((await call('POST', '/forges/nope/ssh-key', {})).status).toBe(404)
    await putForge()

    const { sshKey, notes } = await issue()
    expect(notes).toEqual([])
    expect(sshKey).toMatchObject({
      usage: 'auth_and_signing',
      identity: { name: 'Holtkeeper Bot', email: 'bot@gitlab.test' },
      hostKeysPinned: true,
      expiresAt: '2027-10-30T12:00:00.000Z',
    })
    expect([...keys.values()]).toEqual([
      {
        title: 'holtkeeper (cloud)',
        publicKey: sshKey.publicKey,
        usage: 'auth_and_signing',
        expiresAt: '2027-10-30T12:00:00.000Z',
        scope: { kind: 'user' },
      },
    ])
    const credential = await credentials.get(sshKey.credentialId)
    expect(credential).toMatchObject({ kind: 'ssh', scope: { all: true } })
    const secret = await credentials.reveal(sshKey.credentialId)
    expect(parsePrivateKey(secret).fingerprint).toBe(sshKey.fingerprint)

    const list = (await (await call('GET', '/config/forges')).json()) as ConfigEntryList<'forge'>
    expect(list.entries.find((entry) => entry.id === 'cloud')?.data.sshKey).toEqual(sshKey)
    expect(JSON.stringify(list)).not.toContain('PRIVATE KEY')

    const key = await forgeGitKeys({ store, credentials })('cloud')
    expect(key).toMatchObject({
      privateKey: secret,
      publicKey: sshKey.publicKey,
      knownHosts: `gitlab.test ${hostKey.publicKey}\n`,
      identity: { name: 'Holtkeeper Bot', email: 'bot@gitlab.test' },
    })
    expect(await forgeGitKeys({ store, credentials })('work')).toBeUndefined()
  })

  test('updating the forge keeps its key; rotating replaces it in place', async () => {
    await putForge()
    const first = await issue({ usage: 'signing', expiresInDays: 30 })
    await putForge()
    const kept = (await (await call('GET', '/config/forges')).json()) as ConfigEntryList<'forge'>
    expect(kept.entries.find((entry) => entry.id === 'cloud')?.data.sshKey?.fingerprint).toBe(
      first.sshKey.fingerprint,
    )

    const rotated = await issue()
    expect(rotated.sshKey.credentialId).toBe(first.sshKey.credentialId)
    expect(rotated.sshKey.fingerprint).not.toBe(first.sshKey.fingerprint)
    expect(rotated.sshKey.usage).toBe('signing')
    expect([...keys.keys()]).toEqual(['2'])
    expect(keys.get('2')?.publicKey).toBe(rotated.sshKey.publicKey)

    const actions = (await store.activity.list({})).map((event) => event.action)
    expect(actions).toContain('config.forge.ssh_key_created')
    expect(actions).toContain('config.forge.ssh_key_rotated')
  })

  test('keyscan failure is a note, not an error', async () => {
    keyscanFails = true
    await putForge()
    const { sshKey, notes } = await issue({ identity: { name: 'Bot', email: 'b@x.test' } })
    expect(sshKey.hostKeysPinned).toBe(false)
    expect(sshKey.identity).toEqual({ name: 'Bot', email: 'b@x.test' })
    expect(notes[0]).toContain('host keys not pinned')
  })

  test('removing the key or the forge unregisters it and deletes the credential', async () => {
    await putForge()
    const { sshKey } = await issue()
    expect((await call('DELETE', '/forges/cloud/ssh-key')).status).toBe(204)
    expect(keys.size).toBe(0)
    expect(await credentials.get(sshKey.credentialId)).toBeUndefined()
    expect((await call('DELETE', '/forges/cloud/ssh-key')).status).toBe(404)

    const again = await issue()
    expect((await call('DELETE', '/config/forges/cloud')).status).toBe(204)
    expect(keys.size).toBe(0)
    expect(await credentials.get(again.sshKey.credentialId)).toBeUndefined()
  })
})
