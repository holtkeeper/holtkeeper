import { z } from 'zod'

/** What the OSV database says about an advisory beyond the scan: the text triage reads. */
export interface AdvisoryDetails {
  /** The advisory's long description, shortened to `DETAILS_MAX` characters. */
  details?: string
  /** CVSS vectors, e.g. `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H`. */
  cvss: string[]
  /** CWE ids, e.g. `CWE-94`. */
  cwes: string[]
  published?: string
}

/** Longest `details` kept; advisories with more are mostly code samples and changelogs. */
const DETAILS_MAX = 6000

const recordSchema = z.object({
  details: z.string().nullish(),
  published: z.string().nullish(),
  severity: z
    .array(z.object({ type: z.string().nullish(), score: z.string().nullish() }))
    .nullish()
    .catch(undefined),
  database_specific: z
    .object({ cwe_ids: z.array(z.string()).nullish().catch(undefined) })
    .nullish()
    .catch(undefined),
})

/** Options of `fetchAdvisoryDetails`. */
export interface FetchAdvisoryOptions {
  /** Default: global `fetch`. */
  fetch?: typeof fetch
  /** Default: `https://api.osv.dev`. */
  baseUrl?: string
  /** The request is aborted after this long. Default 10 s. */
  timeoutMs?: number
}

/**
 * The OSV record of advisory `id` (`GET /v1/vulns/<id>`), reduced to `AdvisoryDetails`.
 * Answers `undefined` when OSV does not know the id, answers with an error or cannot be reached;
 * never throws.
 */
export async function fetchAdvisoryDetails(
  id: string,
  options: FetchAdvisoryOptions = {},
): Promise<AdvisoryDetails | undefined> {
  const base = (options.baseUrl ?? 'https://api.osv.dev').replace(/\/+$/u, '')
  try {
    const response = await (options.fetch ?? fetch)(`${base}/v1/vulns/${encodeURIComponent(id)}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    })
    if (!response.ok) return undefined
    const record = recordSchema.safeParse(await response.json()).data
    if (!record) return undefined
    const details = record.details?.trim()
    return {
      ...(details && { details: details.slice(0, DETAILS_MAX) }),
      cvss: (record.severity ?? [])
        .map((entry) => entry.score?.trim() ?? '')
        .filter((score) => score.startsWith('CVSS:')),
      cwes: record.database_specific?.cwe_ids ?? [],
      ...(record.published && { published: record.published }),
    }
  } catch {
    return undefined
  }
}
