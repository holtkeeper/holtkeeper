import { expect, test } from 'bun:test'

import { secretFingerprint } from './fingerprint.ts'
import { matchKvSecrets } from './openbao.ts'

const tree: Record<string, unknown> = {
  '/v1/secret/metadata?list=true': { data: { keys: ['widgets/', 'top'] } },
  '/v1/secret/metadata/widgets?list=true': { data: { keys: ['api', 'locked'] } },
  '/v1/secret/data/top': { data: { data: { token: 'other-value' }, metadata: { version: 1 } } },
  '/v1/secret/data/widgets/api': {
    data: { data: { key: 'some-value', port: 8080 }, metadata: { version: 3 } },
  },
}

test('finds fields whose value has a reported fingerprint and skips forbidden paths', async () => {
  const seen: string[] = []
  const fake = async (url: string | URL | Request, init?: RequestInit) => {
    const path =
      url instanceof Request ? url.url : url.toString().replace('https://bao.example.com', '')
    seen.push(path)
    expect(new Headers(init?.headers).get('x-vault-token')).toBe('t0ken')
    const body = tree[path]
    return body ? Response.json(body) : new Response('forbidden', { status: 403 })
  }
  const matches = await matchKvSecrets({
    address: 'https://bao.example.com/',
    token: 't0ken',
    mount: 'secret',
    fingerprints: [(await secretFingerprint('some-value')).toUpperCase()],
    fetch: fake as typeof fetch,
  })
  expect(matches).toEqual([
    {
      fingerprint: await secretFingerprint('some-value'),
      path: 'widgets/api',
      field: 'key',
      version: 3,
    },
  ])
  expect(seen).toContain('/v1/secret/data/widgets/locked')
})

const failing = async () => new Response('boom', { status: 500 })

test('other HTTP errors throw', async () => {
  expect(
    matchKvSecrets({
      address: 'https://bao.example.com',
      token: 't',
      mount: 'secret',
      fingerprints: [],
      fetch: failing as unknown as typeof fetch,
    }),
  ).rejects.toThrow('HTTP 500')
})
