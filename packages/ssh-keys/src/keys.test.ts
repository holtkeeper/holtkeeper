import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { fingerprint, generateKeyPair, parsePrivateKey, parsePublicKey } from './keys.ts'

const hasKeygen = !!Bun.which('ssh-keygen')

async function keygen(args: string[]) {
  const process = Bun.spawn(['ssh-keygen', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (code !== 0) throw new Error(`ssh-keygen ${args.join(' ')} failed: ${stderr}`)
  return stdout
}

describe('generateKeyPair', () => {
  test('encodes an openssh-key-v1 file with matching check ints and 1, 2, 3 padding', () => {
    const pair = generateKeyPair({ type: 'ed25519', comment: 'holtkeeper@test' })
    expect(pair.publicKey).toMatch(
      /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]+ holtkeeper@test$/,
    )
    expect(pair.privateKey).toStartWith('-----BEGIN OPENSSH PRIVATE KEY-----\n')
    expect(pair.privateKey).toEndWith('-----END OPENSSH PRIVATE KEY-----\n')
    for (const line of pair.privateKey.trim().split('\n').slice(1, -1))
      expect(line.length).toBeLessThanOrEqual(70)
    const info = parsePrivateKey(pair.privateKey)
    expect(info).toEqual({
      type: 'ssh-ed25519',
      publicKey: pair.publicKey,
      comment: 'holtkeeper@test',
      fingerprint: pair.fingerprint,
    })
  })

  test('produces different keys each time', () => {
    const a = generateKeyPair({ type: 'ed25519' })
    const b = generateKeyPair({ type: 'ed25519' })
    expect(a.publicKey).not.toBe(b.publicKey)
    expect(a.publicKey.split(' ')).toHaveLength(2)
  })

  test('rejects comments with line breaks', () => {
    expect(() => generateKeyPair({ type: 'ed25519', comment: 'a\nb' })).toThrow('line breaks')
  })

  test.skipIf(!hasKeygen)('round-trips through ssh-keygen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'holtkeeper-sshkeys-'))
    try {
      const pair = generateKeyPair({ type: 'ed25519', comment: 'bot@holtkeeper' })
      const file = join(dir, 'id_ed25519')
      await writeFile(file, pair.privateKey, { mode: 0o600 })
      await chmod(file, 0o600)
      const derived = (await keygen(['-y', '-f', file])).trim()
      expect(derived.split(' ').slice(0, 2)).toEqual(pair.publicKey.split(' ').slice(0, 2))

      await writeFile(`${file}.pub`, `${pair.publicKey}\n`)
      const listed = await keygen(['-l', '-f', `${file}.pub`])
      expect(listed).toContain(pair.fingerprint)
      expect(listed).toContain('(ED25519)')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test.skipIf(!hasKeygen)('parses keys written by ssh-keygen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'holtkeeper-sshkeys-'))
    try {
      const file = join(dir, 'key')
      await keygen(['-q', '-t', 'ed25519', '-N', '', '-C', 'made by keygen', '-f', file])
      const privateKey = await Bun.file(file).text()
      const publicKey = (await Bun.file(`${file}.pub`).text()).trim()
      const info = parsePrivateKey(privateKey)
      expect(info.publicKey).toBe(publicKey)
      expect(info.comment).toBe('made by keygen')
      expect((await keygen(['-l', '-f', `${file}.pub`])).split(' ')[1]).toBe(fingerprint(publicKey))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('parsePublicKey and fingerprint', () => {
  const pair = generateKeyPair({ type: 'ed25519', comment: 'a comment with spaces' })

  test('splits type, blob and comment', () => {
    const key = parsePublicKey(pair.publicKey)
    expect(key.type).toBe('ssh-ed25519')
    expect(key.comment).toBe('a comment with spaces')
    expect(key.blob).toHaveLength(51)
    expect(key.fingerprint).toBe(pair.fingerprint)
  })

  test('is SHA-256 of the blob in unpadded base64', () => {
    const blob = Buffer.from(pair.publicKey.split(' ')[1]!, 'base64')
    const expected = createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')
    expect(fingerprint(pair.publicKey)).toBe(`SHA256:${expected}`)
    expect(fingerprint(pair.publicKey)).not.toContain('=')
  })

  test('accepts other algorithms', () => {
    const rsa =
      'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQDPaBUWt7ksxkfVzTv3ydnC9UEnpD2mJfvl6IOcISfpbqKYQnQsuy4cF8LuFLI+m3nL8OGMyQgyz9O7xyGVoTsNfVITVvuDOAMWjRo2ZtHlqUIV5O9eY5KFZ7X91w+CuOuGcOFpQS3+v70yK0/OEZ7L9dAqClRe/8D+9yCkuw1HRw=='
    expect(parsePublicKey(rsa).type).toBe('ssh-rsa')
  })

  test('rejects malformed lines and type mismatches', () => {
    expect(() => parsePublicKey('nope')).toThrow()
    const blob = pair.publicKey.split(' ')[1]
    expect(() => parsePublicKey(`ssh-rsa ${blob}`)).toThrow('contains ssh-ed25519')
  })
})

describe('parsePrivateKey', () => {
  test('rejects damaged keys', () => {
    const pair = generateKeyPair({ type: 'ed25519' })
    expect(() => parsePrivateKey('garbage')).toThrow('not an OpenSSH private key')
    const lines = pair.privateKey.trim().split('\n')
    const body = Buffer.from(lines.slice(1, -1).join(''), 'base64')
    // Flip a byte of the second check int.
    const sectionStart = body.length - Math.ceil((4 + 4 + 15 + 36 + 68 + 4) / 8) * 8
    body[sectionStart + 4] = body[sectionStart + 4]! ^ 0xff
    const damaged = `${lines[0]}\n${body.toString('base64')}\n${lines.at(-1)}\n`
    expect(() => parsePrivateKey(damaged)).toThrow('check ints')
  })
})
