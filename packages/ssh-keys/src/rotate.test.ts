import { describe, expect, test } from 'bun:test'

import type { GitForge, SshKeyListScope, SshKeyRegistration } from '@holtkeeper/forge'

import type { SshCredentialOptions } from './credential.ts'
import { generateKeyPair } from './keys.ts'
import { rotateSshKey } from './rotate.ts'

function fakeForge(options: { failRegisterAt?: number; failRemove?: string } = {}) {
  const keys = new Map<string, SshKeyRegistration>()
  const log: string[] = []
  let next = 100
  const forge = {
    kind: 'fake',
    async registerSshKey(key: SshKeyRegistration) {
      if (options.failRegisterAt === keys.size) throw new Error('forge said no')
      const id = String(next++)
      keys.set(id, key)
      log.push(`register ${id} ${key.scope.kind}`)
      return { id }
    },
    async removeSshKey(id: string, scope: SshKeyListScope) {
      if (options.failRemove === id) throw new Error('cannot remove')
      keys.delete(id)
      log.push(`remove ${id} ${scope.kind}`)
    },
  } as unknown as GitForge
  return { forge, keys, log }
}

const old = generateKeyPair({ type: 'ed25519' })
const current: SshCredentialOptions = {
  publicKey: old.publicKey,
  fingerprint: old.fingerprint,
  usage: 'auth',
  registered: [
    { forge: 'gitlab', scope: { kind: 'user' }, id: '1' },
    { forge: 'gitlab', scope: { kind: 'deploy', repo: 'games/a', canPush: true }, id: '2' },
  ],
  knownHosts: 'gitlab.test ssh-ed25519 AAAA\n',
}

describe('rotateSshKey', () => {
  test('registers the new key, activates it, then removes the old registrations', async () => {
    const { forge, log } = fakeForge()
    const activated: SshCredentialOptions[] = []
    const result = await rotateSshKey({
      current,
      forge: () => forge,
      title: 'holtkeeper bot',
      expiresAt: '2027-01-01T00:00:00Z',
      async activate(next) {
        log.push('activate')
        expect(next.secret).toContain('OPENSSH PRIVATE KEY')
        activated.push(next.options)
      },
    })
    expect(log).toEqual([
      'register 100 user',
      'register 101 deploy',
      'activate',
      'remove 1 user',
      'remove 2 deploy',
    ])
    expect(result.options.fingerprint).not.toBe(old.fingerprint)
    expect(result.options.registered.map((ref) => ref.id)).toEqual(['100', '101'])
    expect(result.options.knownHosts).toBe(current.knownHosts)
    expect(activated).toEqual([result.options])
    expect(result.removed).toEqual(current.registered)
  })

  test('rolls back new registrations when one fails, leaving the old key alone', async () => {
    const { forge, keys, log } = fakeForge({ failRegisterAt: 1 })
    const promise = rotateSshKey({
      current,
      forge: () => forge,
      title: 't',
      activate: async () => {},
    })
    expect(promise).rejects.toThrow('forge said no')
    await promise.catch(() => undefined)
    expect(keys.size).toBe(0)
    expect(log).toEqual(['register 100 user', 'remove 100 user'])
  })

  test('rolls back when activation fails', async () => {
    const { forge, keys } = fakeForge()
    const promise = rotateSshKey({
      current,
      forge: () => forge,
      title: 't',
      activate: async () => {
        throw new Error('store down')
      },
    })
    expect(promise).rejects.toThrow('store down')
    await promise.catch(() => undefined)
    expect(keys.size).toBe(0)
  })

  test('reports old keys it could not remove', async () => {
    const { forge } = fakeForge({ failRemove: '2' })
    const result = await rotateSshKey({
      current,
      forge: () => forge,
      title: 't',
      activate: async () => {},
    })
    expect(result.removed.map((ref) => ref.id)).toEqual(['1'])
    expect(result.failedRemovals).toEqual([{ ref: current.registered[1]!, error: 'cannot remove' }])
  })

  test('refuses forges without SSH key methods', async () => {
    const promise = rotateSshKey({
      current,
      forge: () => ({ kind: 'bare' }) as unknown as GitForge,
      title: 't',
      activate: async () => {},
    })
    expect(promise).rejects.toThrow('cannot register')
  })
})
