import { describe, expect, test } from 'bun:test'

import { createFakeRunner } from '@holtkeeper/exec/testing'

import { generateKeyPair } from './keys.ts'
import {
  formatKnownHosts,
  HostKeyMismatchError,
  knownHostsName,
  parseKnownHosts,
  pinHostKeys,
  scanHostKeys,
} from './known-hosts.ts'

const edKey = generateKeyPair({ type: 'ed25519' })
const otherKey = generateKeyPair({ type: 'ed25519' })
const keyscanOutput = (host: string) =>
  [
    `# ${host}:22 SSH-2.0-OpenSSH_9.6`,
    `${host} ${edKey.publicKey}`,
    `${host} ${otherKey.publicKey}`,
    '',
  ].join('\n')

describe('parseKnownHosts', () => {
  test('keeps plain host lines and skips comments, markers and junk', () => {
    const text = [
      '# comment',
      '',
      `gitlab.test ${edKey.publicKey}`,
      `@cert-authority *.test ${otherKey.publicKey}`,
      'broken line',
      `[git.test]:2222 ${otherKey.publicKey} trailing comment`,
    ].join('\n')
    const keys = parseKnownHosts(text)
    expect(keys.map((key) => key.hosts)).toEqual(['gitlab.test', '[git.test]:2222'])
    expect(keys[0]?.fingerprint).toBe(edKey.fingerprint)
    expect(formatKnownHosts(keys)).toBe(
      `gitlab.test ${edKey.publicKey}\n[git.test]:2222 ${otherKey.publicKey}\n`,
    )
  })

  test('names non-standard ports in brackets', () => {
    expect(knownHostsName('a.test')).toBe('a.test')
    expect(knownHostsName('a.test', 2222)).toBe('[a.test]:2222')
  })
})

describe('scanHostKeys', () => {
  test('runs ssh-keyscan with types, timeout and port', async () => {
    const { runner, calls } = createFakeRunner(() => ({ stdout: keyscanOutput('[git.test]:2222') }))
    const keys = await scanHostKeys({ host: 'git.test', port: 2222, runner })
    expect(calls[0]?.command).toEqual([
      'ssh-keyscan',
      '-T',
      '10',
      '-t',
      'ed25519,ecdsa,rsa',
      '-p',
      '2222',
      'git.test',
    ])
    expect(keys).toHaveLength(2)
  })

  test('rejects option-like hosts and empty answers', async () => {
    const { runner } = createFakeRunner(() => ({ stdout: '' }))
    expect(scanHostKeys({ host: '-oProxyCommand=x', runner })).rejects.toThrow('invalid host')
    expect(scanHostKeys({ host: 'gitlab.test', runner })).rejects.toThrow('no host keys')
  })
})

describe('pinHostKeys', () => {
  test('keeps only keys with expected fingerprints', async () => {
    const { runner } = createFakeRunner(() => ({ stdout: keyscanOutput('gitlab.test') }))
    const pinned = await pinHostKeys({
      host: 'gitlab.test',
      runner,
      fingerprints: [edKey.fingerprint],
    })
    expect(pinned.keys.map((key) => key.fingerprint)).toEqual([edKey.fingerprint])
    expect(pinned.knownHosts).toBe(`gitlab.test ${edKey.publicKey}\n`)
  })

  test('throws when nothing matches', async () => {
    const { runner } = createFakeRunner(() => ({ stdout: keyscanOutput('gitlab.test') }))
    const promise = pinHostKeys({ host: 'gitlab.test', runner, fingerprints: ['SHA256:nope'] })
    expect(promise).rejects.toBeInstanceOf(HostKeyMismatchError)
  })

  test('trusts every offered key without fingerprints', async () => {
    const { runner } = createFakeRunner(() => ({ stdout: keyscanOutput('gitlab.test') }))
    expect((await pinHostKeys({ host: 'gitlab.test', runner })).keys).toHaveLength(2)
  })
})
