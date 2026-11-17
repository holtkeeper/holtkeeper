import { describe, expect, test } from 'bun:test'

import { osvClient } from './api.ts'

interface BatchBody {
  queries: { package: { name: string; ecosystem: string }; version: string; page_token?: string }[]
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('osvClient', () => {
  test('splits queries into batches and follows page tokens, keeping query order', async () => {
    const bodies: BatchBody[] = []
    const fetch = (async (_url: string, init?: RequestInit) => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the client sends this shape
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as BatchBody
      bodies.push(body)
      return json({
        results: body.queries.map((query) => {
          if (query.package.name === 'paged' && !query.page_token)
            return {
              vulns: [{ id: 'GHSA-1', modified: '2026-01-01T00:00:00Z' }],
              next_page_token: 't1',
            }
          if (query.package.name === 'paged')
            return { vulns: [{ id: 'GHSA-2', modified: '2026-01-02T00:00:00Z' }] }
          if (query.package.name === 'clean') return {}
          return { vulns: [{ id: `GHSA-${query.package.name}`, modified: '2026-01-03T00:00:00Z' }] }
        }),
      })
    }) as typeof globalThis.fetch
    const client = osvClient({ fetch, batchSize: 2 })
    const found = await client.queryBatch([
      { ecosystem: 'npm', name: 'paged', version: '1.0.0' },
      { ecosystem: 'npm', name: 'clean', version: '1.0.0' },
      { ecosystem: 'Go', name: 'example.com/x', version: '0.1.0' },
    ])
    expect(found.map((refs) => refs.map((ref) => ref.id))).toEqual([
      ['GHSA-1', 'GHSA-2'],
      [],
      ['GHSA-example.com/x'],
    ])
    expect(bodies.map((body) => body.queries.length)).toEqual([2, 1, 1])
    expect(bodies[2]?.queries[0]).toEqual({
      package: { name: 'paged', ecosystem: 'npm' },
      version: '1.0.0',
      page_token: 't1',
    })
  })

  test('throws when a batch fails so no package reads as unaffected', async () => {
    const client = osvClient({ fetch: (async () => json({}, 503)) as unknown as typeof fetch })
    expect(client.queryBatch([{ ecosystem: 'npm', name: 'x', version: '1.0.0' }])).rejects.toThrow(
      '503',
    )
  })

  test('reads records, answers undefined for unknown ids and throws on errors', async () => {
    const fetch = (async (url: string) => {
      if (url.endsWith('/GHSA-known'))
        return json({ id: 'GHSA-known', modified: '2026-01-01T00:00:00Z', details: 'long text' })
      if (url.endsWith('/GHSA-gone')) return json({}, 404)
      return json({}, 500)
    }) as typeof globalThis.fetch
    const client = osvClient({ fetch, baseUrl: 'https://osv.example/' })
    expect(await client.vulnerability('GHSA-known')).toEqual({
      id: 'GHSA-known',
      modified: '2026-01-01T00:00:00Z',
    })
    expect(await client.vulnerability('GHSA-gone')).toBeUndefined()
    expect(client.vulnerability('GHSA-broken')).rejects.toThrow('500')
  })
})
