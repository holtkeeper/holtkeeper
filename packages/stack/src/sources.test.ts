import { expect, test } from 'bun:test'

import { createHttpSources } from './index.ts'

const json = (body: unknown, init?: ResponseInit) => Response.json(body, init)

test('reads lifecycles, package versions and Docker Hub tags, caching each answer', async () => {
  const calls: string[] = []
  const sources = createHttpSources({
    fetch: async (url) => {
      calls.push(url)
      if (url.endsWith('/api/nodejs.json'))
        return json([
          { cycle: '24', eol: '2028-04-30', lts: '2025-10-28', latest: '24.11.0' },
          { cycle: 18, eol: true, lts: false },
          { eol: false },
        ])
      if (url.includes('registry.npmjs.org/pnpm'))
        return json({ 'dist-tags': { latest: '10.20.0' } })
      if (url.includes('pypi.org/pypi/uv/json')) return json({ info: { version: '0.9.0' } })
      if (url.includes('page_size=100'))
        return json({ results: [{ name: '1.27.3' }, { name: 'latest' }], next: null })
      return new Response('', { status: 404 })
    },
  })
  expect(await sources.lifecycle('nodejs')).toEqual([
    { cycle: '24', eol: '2028-04-30', lts: '2025-10-28', latest: '24.11.0' },
    { cycle: '18', eol: true },
  ])
  expect(await sources.lifecycle('nodejs')).toHaveLength(2)
  expect(await sources.lifecycle('unknown')).toBeUndefined()
  expect(await sources.npm('pnpm')).toBe('10.20.0')
  expect(await sources.pypi('uv')).toBe('0.9.0')
  expect(await sources.imageTags('docker.io', 'library/nginx')).toEqual(['1.27.3', 'latest'])
  expect(calls.filter((url) => url.endsWith('/api/nodejs.json'))).toHaveLength(1)
})

test('asks other registries for an anonymous token when challenged', async () => {
  const calls: string[] = []
  const sources = createHttpSources({
    fetch: async (url, init) => {
      calls.push(url)
      if (url.startsWith('https://ghcr.io/token')) return json({ token: 'anonymous' })
      const authorized = new Headers(init?.headers).get('authorization') === 'Bearer anonymous'
      return authorized
        ? json({ tags: ['2.3.0', '2.4.1'] })
        : new Response('', {
            status: 401,
            headers: {
              'www-authenticate':
                'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:acme/base:pull"',
            },
          })
    },
  })
  expect(await sources.imageTags('ghcr.io', 'acme/base')).toEqual(['2.3.0', '2.4.1'])
  expect(calls).toEqual([
    'https://ghcr.io/v2/acme/base/tags/list?n=1000',
    'https://ghcr.io/token?service=ghcr.io&scope=repository%3Aacme%2Fbase%3Apull',
    'https://ghcr.io/v2/acme/base/tags/list?n=1000',
  ])
})
