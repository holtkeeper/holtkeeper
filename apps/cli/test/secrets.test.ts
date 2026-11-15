import { expect, test } from 'bun:test'

import { secretFingerprint } from '@holtkeeper/secret-reports'

import { secretsCommand } from '../src/secrets.ts'
import { UsageError } from '../src/serve.ts'

const io = (stdin: string, env: Record<string, string> = {}, fetch?: typeof globalThis.fetch) => ({
  stdin: async () => stdin,
  env,
  ...(fetch && { fetch }),
})

test('fingerprint prints the fingerprint of stdin without its trailing newline', async () => {
  const lines: string[] = []
  expect(
    await secretsCommand(['fingerprint'], {}, (line) => lines.push(line), io('some-value\n')),
  ).toBe(0)
  expect(lines).toEqual([await secretFingerprint('some-value')])
  expect(secretsCommand(['fingerprint'], {}, () => {}, io(''))).rejects.toBeInstanceOf(UsageError)
})

const fake = async (url: string | URL | Request) => {
  const path =
    new URL(url instanceof Request ? url.url : url.toString()).pathname +
    new URL(url instanceof Request ? url.url : url.toString()).search
  if (path === '/v1/secret/metadata?list=true')
    return Response.json({ data: { keys: ['widgets'] } })
  if (path === '/v1/secret/data/widgets')
    return Response.json({ data: { data: { key: 'some-value' }, metadata: { version: 2 } } })
  return new Response('', { status: 404 })
}

test('match walks the KV engine and prints mount path, field and version', async () => {
  const fingerprint = await secretFingerprint('some-value')
  const lines: string[] = []
  const code = await secretsCommand(
    ['match', fingerprint],
    { address: 'https://bao.example.com', mount: 'secret' },
    (line) => lines.push(line),
    io('', { BAO_TOKEN: 't' }, fake as typeof fetch),
  )
  expect(code).toBe(0)
  expect(lines).toEqual([`${fingerprint}\tsecret/widgets\tkey\t2`])

  const none: string[] = []
  expect(
    await secretsCommand(
      ['match', '0123456789abcdef'],
      { address: 'https://bao.example.com', mount: 'secret' },
      (line) => none.push(line),
      io('', { VAULT_TOKEN: 't' }, fake as typeof fetch),
    ),
  ).toBe(1)
  expect(none).toEqual(['No secret has these fingerprints.'])
})

const run = (args: string[], flags: Record<string, string>, env: Record<string, string> = {}) =>
  secretsCommand(args, flags, () => {}, io('', env))

test('match needs fingerprints, an address, a mount and a token', async () => {
  expect(run(['match', 'nope'], {})).rejects.toThrow('16 hex')
  expect(run(['match', '0123456789abcdef'], { mount: 'secret' })).rejects.toThrow('--address')
  expect(
    run(['match', '0123456789abcdef'], { address: 'https://bao.example.com' }),
  ).rejects.toThrow('--mount')
  expect(
    run(['match', '0123456789abcdef'], { address: 'https://bao.example.com', mount: 'secret' }),
  ).rejects.toThrow('BAO_TOKEN')
  expect(run(['other'], {})).rejects.toThrow('expected fingerprint or match')
})
