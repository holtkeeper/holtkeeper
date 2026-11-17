import { z } from 'zod'

import { type OsvRecord, osvRecordSchema } from './records.ts'

/** One package version to look up, named the way OSV names it. */
export interface OsvPackageQuery {
  /** OSV ecosystem name: `npm`, `Go`, ... */
  ecosystem: string
  name: string
  /** As OSV spells it: Go versions without the `v` prefix. */
  version: string
}

/** An advisory affecting a queried package, with the time its record last changed. */
export interface OsvVulnRef {
  id: string
  modified: string
}

/** The parts of the OSV API (https://google.github.io/osv.dev/api/) a fleet index needs. */
export interface OsvClient {
  /**
   * The advisories affecting each query, in query order; OSV matches the versions against the
   * affected ranges itself. Batches and pages are followed internally. Throws when a request fails,
   * so a partial answer is never mistaken for "not affected".
   */
  queryBatch(
    queries: readonly OsvPackageQuery[],
    options?: { signal?: AbortSignal },
  ): Promise<OsvVulnRef[][]>
  /** The full record of one advisory; `undefined` when OSV does not know the id. Throws otherwise. */
  vulnerability(id: string, options?: { signal?: AbortSignal }): Promise<OsvRecord | undefined>
}

/** Options of `osvClient`. */
export interface OsvClientOptions {
  /** Default: global `fetch`. */
  fetch?: typeof fetch
  /** Default: `https://api.osv.dev`. */
  baseUrl?: string
  /** Queries per `querybatch` request; OSV accepts at most 1000. */
  batchSize?: number
  /** Each request is aborted after this long. Default 30 s. */
  timeoutMs?: number
}

const batchResponseSchema = z.object({
  results: z.array(
    z.object({
      vulns: z.array(z.object({ id: z.string(), modified: z.string() })).nullish(),
      next_page_token: z.string().nullish(),
    }),
  ),
})

/** An `OsvClient` over the public OSV API, or a mirror speaking it at `baseUrl`. */
export function osvClient(options: OsvClientOptions = {}): OsvClient {
  const base = (options.baseUrl ?? 'https://api.osv.dev').replace(/\/+$/u, '')
  const doFetch = options.fetch ?? fetch
  const batchSize = Math.min(Math.max(options.batchSize ?? 1000, 1), 1000)
  const timeoutMs = options.timeoutMs ?? 30_000
  const signalOf = (signal?: AbortSignal) =>
    signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs)

  const postBatch = async (
    queries: { query: OsvPackageQuery; pageToken?: string }[],
    signal?: AbortSignal,
  ) => {
    const response = await doFetch(`${base}/v1/querybatch`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        queries: queries.map(({ query, pageToken }) => ({
          package: { name: query.name, ecosystem: query.ecosystem },
          version: query.version,
          ...(pageToken && { page_token: pageToken }),
        })),
      }),
      signal: signalOf(signal),
    })
    if (!response.ok) throw new Error(`OSV querybatch answered ${response.status}`)
    const parsed = batchResponseSchema.parse(await response.json())
    if (parsed.results.length !== queries.length)
      throw new Error(
        `OSV querybatch answered ${parsed.results.length} results for ${queries.length} queries`,
      )
    return parsed.results
  }

  return {
    async queryBatch(queries, { signal } = {}) {
      const found: OsvVulnRef[][] = queries.map(() => [])
      let pending = queries.map((query, index) => ({
        index,
        query,
        pageToken: undefined as string | undefined,
      }))
      while (pending.length) {
        const next: typeof pending = []
        for (let start = 0; start < pending.length; start += batchSize) {
          const chunk = pending.slice(start, start + batchSize)
          // Batches go one after another: OSV rate-limits bursts, and a fleet needs only a few.
          // oxlint-disable-next-line no-await-in-loop
          const results = await postBatch(chunk, signal)
          for (const [position, result] of results.entries()) {
            const item = chunk[position]
            if (!item) continue
            found[item.index]?.push(...(result.vulns ?? []))
            if (result.next_page_token) next.push({ ...item, pageToken: result.next_page_token })
          }
        }
        pending = next
      }
      return found
    },

    async vulnerability(id, { signal } = {}) {
      const response = await doFetch(`${base}/v1/vulns/${encodeURIComponent(id)}`, {
        headers: { accept: 'application/json' },
        signal: signalOf(signal),
      })
      if (response.status === 404) return undefined
      if (!response.ok) throw new Error(`OSV answered ${response.status} for ${id}`)
      return osvRecordSchema.parse(await response.json())
    },
  }
}
