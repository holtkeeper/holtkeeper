import { expect, test } from 'bun:test'

import { uploadAnalysis } from '../src/analyze.ts'

test('analysis uploads carry run artifacts as base64', async () => {
  const sent: { url: string; body: unknown }[] = []
  const fetcher = (async (url: string, init?: RequestInit) => {
    sent.push({ url, body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') })
    return Response.json({ id: 'an-1' }, { status: 201 })
  }) as typeof fetch
  const url = await uploadAnalysis(
    'http://keeper.test/',
    'work:web/site',
    {
      kind: 'assets',
      data: { ok: true },
      artifacts: [
        {
          id: 'a'.repeat(64),
          data: new Uint8Array([1, 2, 3]),
          contentType: 'image/webp',
          name: 'public/a.webp',
        },
      ],
    },
    fetcher,
  )
  expect(url).toBe('http://keeper.test/analyses/an-1')
  expect(sent[0]).toEqual({
    url: 'http://keeper.test/api/analyses',
    body: {
      repo: { forge: 'work', path: 'web/site' },
      kind: 'assets',
      data: { ok: true },
      artifacts: [
        { id: 'a'.repeat(64), base64: 'AQID', contentType: 'image/webp', name: 'public/a.webp' },
      ],
    },
  })
  await uploadAnalysis('http://keeper.test', 'work:web/site', { kind: 'assets', data: {} }, fetcher)
  expect(sent[1]?.body).toEqual({
    repo: { forge: 'work', path: 'web/site' },
    kind: 'assets',
    data: {},
  })
})
