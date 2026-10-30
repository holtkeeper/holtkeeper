import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFakeRunner } from '@holtkeeper/exec/testing'
import { generateKeyPair } from '@holtkeeper/ssh-keys'

import { checkout } from './checkout.ts'
import { gitSshCommand, sshCloneUrl } from './ssh.ts'

const key = generateKeyPair({ type: 'ed25519', comment: 'bot' })

describe('sshCloneUrl', () => {
  test('turns HTTPS clone URLs into scp-like SSH URLs', () => {
    expect(sshCloneUrl('https://gitlab.test/games/app.git')).toBe('git@gitlab.test:games/app.git')
    expect(sshCloneUrl('https://gitlab.test:8443/games/app/')).toBe('git@gitlab.test:games/app.git')
  })

  test('keeps SSH URLs and refuses other schemes', () => {
    expect(sshCloneUrl('ssh://git@gitlab.test:2222/a/b.git')).toBe(
      'ssh://git@gitlab.test:2222/a/b.git',
    )
    expect(sshCloneUrl('git@gitlab.test:a/b.git')).toBe('git@gitlab.test:a/b.git')
    expect(() => sshCloneUrl('file:///tmp/repo')).toThrow('file:')
  })
})

describe('gitSshCommand', () => {
  test('pins the key and known hosts and quotes paths for the shell', () => {
    expect(gitSshCommand("/tmp/it's/id", '/tmp/kh')).toBe(
      "ssh -i '/tmp/it'\\''s/id' -o IdentitiesOnly=yes -o UserKnownHostsFile='/tmp/kh' -o StrictHostKeyChecking=yes -o BatchMode=yes -F /dev/null",
    )
  })
})

describe('checkout over SSH', () => {
  test('sets GIT_SSH_COMMAND only for remote calls, with a 0600 key removed afterwards', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'holtkeeper-ws-ssh-'))
    const seen: { file: string; mode: number; content: string }[] = []
    try {
      const { runner, calls } = createFakeRunner(async (command, options) => {
        const sshCommand = options.env?.['GIT_SSH_COMMAND']
        if (sshCommand) {
          const file = /-i '([^']+)'/.exec(sshCommand)?.[1] ?? ''
          seen.push({
            file,
            mode: (await stat(file)).mode & 0o777,
            content: await Bun.file(file).text(),
          })
          expect((await stat(join(file, '..'))).mode & 0o777).toBe(0o700)
        }
        if (command.includes('symbolic-ref')) return { stdout: 'main\n' }
        if (command.includes('rev-parse')) return { stdout: 'abc123\n' }
        return undefined
      })
      const result = await checkout({
        cloneUrl: 'https://gitlab.test/games/a.git',
        ssh: { privateKey: key.privateKey, knownHosts: 'gitlab.test ssh-ed25519 AAAA\n' },
        credentials: { username: 'oauth2', password: 'unused' },
        cacheDir,
        workDir: cacheDir,
        runner,
      })
      const clone = calls.find((call) => call.command.includes('clone'))
      expect(clone?.command).toContain('git@gitlab.test:games/a.git')
      expect(clone?.options.env?.['HOLTKEEPER_GIT_PASSWORD']).toBeUndefined()
      expect(seen).toHaveLength(1)
      expect(seen[0]?.mode).toBe(0o600)
      expect(seen[0]?.content).toBe(key.privateKey)
      expect(await Bun.file(seen[0]!.file).exists()).toBeFalse()
      const local = calls.filter((call) => !call.command.includes('clone'))
      expect(local.every((call) => call.options.env?.['GIT_SSH_COMMAND'] === undefined)).toBeTrue()
      expect(calls.some((call) => call.command.join(' ').includes('PRIVATE KEY'))).toBeFalse()
      await result.cleanup()
    } finally {
      await rm(cacheDir, { recursive: true, force: true })
    }
  })

  test('refuses a signing key whose halves do not match', async () => {
    const other = generateKeyPair({ type: 'ed25519' })
    const { runner } = createFakeRunner()
    expect(
      checkout({
        cloneUrl: 'https://gitlab.test/games/a.git',
        signing: {
          privateKey: key.privateKey,
          publicKey: other.publicKey,
          name: 'b',
          email: 'b@x',
        },
        cacheDir: '/nonexistent',
        runner,
      }),
    ).rejects.toThrow('does not match')
  })
})
