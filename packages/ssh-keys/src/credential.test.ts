import { describe, expect, test } from 'bun:test'

import {
  createSshCredentialInput,
  readSshCredential,
  validateSshCredentialOptions,
} from './credential.ts'
import { generateKeyPair } from './keys.ts'

const pair = generateKeyPair({ type: 'ed25519', comment: 'bot' })
const registered = [{ forge: 'gitlab', scope: { kind: 'user' as const }, id: '7' }]

describe('createSshCredentialInput', () => {
  test('puts the private key in the secret and the rest in options', () => {
    const input = createSshCredentialInput({
      name: 'bot ssh',
      url: 'https://gitlab.test',
      scope: { kind: 'global' },
      keyPair: pair,
      usage: 'auth_and_signing',
      registered,
      knownHosts: 'gitlab.test ssh-ed25519 AAAA\n',
    })
    expect(input).toEqual({
      name: 'bot ssh',
      kind: 'ssh',
      url: 'https://gitlab.test',
      scope: { kind: 'global' },
      secret: pair.privateKey,
      options: {
        publicKey: pair.publicKey,
        fingerprint: pair.fingerprint,
        usage: 'auth_and_signing',
        registered,
        knownHosts: 'gitlab.test ssh-ed25519 AAAA\n',
      },
    })
    expect(JSON.stringify(input.options)).not.toContain('PRIVATE KEY')
  })
})

describe('validateSshCredentialOptions', () => {
  const valid = {
    publicKey: pair.publicKey,
    fingerprint: pair.fingerprint,
    usage: 'auth',
    registered,
  }

  test('ignores other kinds and accepts valid options', () => {
    expect(validateSshCredentialOptions('gitlab', {})).toBeUndefined()
    expect(validateSshCredentialOptions('ssh', valid)).toEqual([])
  })

  test('reports field problems', () => {
    const other = generateKeyPair({ type: 'ed25519' })
    expect(
      validateSshCredentialOptions('ssh', { ...valid, fingerprint: other.fingerprint }),
    ).toEqual(['options.fingerprint: does not match publicKey'])
    const issues = validateSshCredentialOptions('ssh', {
      ...valid,
      usage: 'everything',
      registered: [{ forge: 'gitlab', scope: { kind: 'deploy', repo: 'a/b' }, id: '1' }],
    })
    expect(issues?.some((issue) => issue.startsWith('options.usage'))).toBeTrue()
    expect(issues?.some((issue) => issue.startsWith('options.registered.0.scope'))).toBeTrue()
  })
})

describe('readSshCredential', () => {
  test('checks that the secret belongs to the public key', () => {
    const options = {
      publicKey: pair.publicKey,
      fingerprint: pair.fingerprint,
      usage: 'auth',
      registered,
    }
    expect(readSshCredential(pair.privateKey, options).privateKey).toBe(pair.privateKey)
    const other = generateKeyPair({ type: 'ed25519' })
    expect(() => readSshCredential(other.privateKey, options)).toThrow('does not match')
  })
})
