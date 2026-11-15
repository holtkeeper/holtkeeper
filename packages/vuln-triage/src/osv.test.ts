import { describe, expect, test } from 'bun:test'

import { fetchAdvisoryDetails } from './osv.ts'

const answering = (status: number, body: unknown, seen: string[] = []): typeof fetch =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a fetch double
  (async (url: string) => {
    seen.push(url)
    return new Response(JSON.stringify(body), { status })
  }) as typeof fetch

describe('fetchAdvisoryDetails', () => {
  test('reads details, CVSS vectors and CWEs', async () => {
    const seen: string[] = []
    const details = await fetchAdvisoryDetails('GHSA-aaaa-bbbb-cccc', {
      baseUrl: 'https://osv.test/',
      fetch: answering(
        200,
        {
          id: 'GHSA-aaaa-bbbb-cccc',
          details: '  Widget templates evaluate input.  ',
          published: '2026-11-01T00:00:00Z',
          severity: [
            { type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' },
            { type: 'Ubuntu', score: 'high' },
          ],
          database_specific: { cwe_ids: ['CWE-94'] },
        },
        seen,
      ),
    })
    expect(seen).toEqual(['https://osv.test/v1/vulns/GHSA-aaaa-bbbb-cccc'])
    expect(details).toEqual({
      details: 'Widget templates evaluate input.',
      cvss: ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H'],
      cwes: ['CWE-94'],
      published: '2026-11-01T00:00:00Z',
    })
  })

  test('answers undefined for unknown ids, errors and failed requests', async () => {
    expect(await fetchAdvisoryDetails('MAL-1', { fetch: answering(404, {}) })).toBeUndefined()
    expect(await fetchAdvisoryDetails('MAL-1', { fetch: answering(500, {}) })).toBeUndefined()
    const failing = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    expect(await fetchAdvisoryDetails('MAL-1', { fetch: failing })).toBeUndefined()
  })

  test('tolerates missing fields', async () => {
    expect(await fetchAdvisoryDetails('MAL-1', { fetch: answering(200, { id: 'MAL-1' }) })).toEqual(
      { cvss: [], cwes: [] },
    )
  })
})
