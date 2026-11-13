import {
  GO_GUIDELINES_MAX_BYTES,
  GO_GUIDELINES_TAG,
  type StoredGoGuidelines,
  parseGoGuidelines,
} from './schema.ts'

/** GitHub repository the guidelines come from. */
export const GO_GUIDELINES_REPOSITORY = 'JetBrains/go-modern-guidelines'
const DATA_PATH = 'internal/guidelines/guidelines.json'
const TIMEOUT_MS = 30_000

/** What `refreshGoGuidelines` needs; everything is optional. */
export interface GoGuidelinesRefreshOptions {
  /** Default: global `fetch`. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>
  /** The copy kept so far: its tag and tag-listing ETag avoid downloading the same data again. */
  previous?: StoredGoGuidelines
  /** Download this release tag instead of looking up the newest one. */
  tag?: string
  now?: Date
  signal?: AbortSignal
}

/**
 * Outcome of one refresh: `updated` with a new copy, `unchanged` with the previous copy and a new
 * `checkedAt`, or `failed` with the reason (the caller keeps what it had).
 */
export type GoGuidelinesRefresh =
  | { status: 'updated'; stored: StoredGoGuidelines }
  | { status: 'unchanged'; stored: StoredGoGuidelines }
  | { status: 'failed'; error: string }

const compareTags = (a: string, b: string) => {
  const left = a.slice(1).split('.').map(Number)
  const right = b.slice(1).split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff) return diff
  }
  return 0
}

/** The newest `vX.Y.Z` tag among `names`; prerelease and other tags are ignored. */
export function latestGoGuidelinesTag(names: readonly string[]): string | undefined {
  return names
    .filter((name) => GO_GUIDELINES_TAG.test(name))
    .toSorted(compareTags)
    .at(-1)
}

const failure = (response: Response, what: string) => {
  const remaining = response.headers.get('x-ratelimit-remaining')
  const reset = Number(response.headers.get('x-ratelimit-reset'))
  if ((response.status === 403 || response.status === 429) && remaining === '0')
    return `${what}: GitHub rate limit reached${reset ? ` until ${new Date(reset * 1000).toISOString()}` : ''}`
  return `${what}: HTTP ${response.status}`
}

/**
 * Downloads the guidelines of the newest upstream release (or of `options.tag`) and validates them.
 * The tag listing goes to the GitHub API unauthenticated with the previous ETag, so an unchanged
 * listing costs no rate limit; the data file comes from raw.githubusercontent.com at that tag. A
 * tag equal to the previous copy's is not downloaded again. Never throws.
 */
export async function refreshGoGuidelines(
  options: GoGuidelinesRefreshOptions = {},
): Promise<GoGuidelinesRefresh> {
  const fetcher = options.fetch ?? fetch
  const now = (options.now ?? new Date()).toISOString()
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  const previous = options.previous
  try {
    let tag = options.tag
    let tagsEtag = previous?.tagsEtag
    if (tag && !GO_GUIDELINES_TAG.test(tag)) return { status: 'failed', error: `bad tag ${tag}` }
    if (!tag) {
      const response = await fetcher(
        `https://api.github.com/repos/${GO_GUIDELINES_REPOSITORY}/tags?per_page=100`,
        {
          headers: {
            accept: 'application/vnd.github+json',
            'user-agent': 'holtkeeper',
            'x-github-api-version': '2022-11-28',
            ...(previous?.tagsEtag ? { 'if-none-match': previous.tagsEtag } : {}),
          },
          signal,
        },
      )
      if (response.status === 304 && previous)
        return { status: 'unchanged', stored: { ...previous, checkedAt: now } }
      if (!response.ok) return { status: 'failed', error: failure(response, 'tag listing') }
      const body: unknown = await response.json()
      const names = Array.isArray(body)
        ? body.flatMap((item: unknown) =>
            item && typeof item === 'object' && 'name' in item && typeof item.name === 'string'
              ? [item.name]
              : [],
          )
        : []
      tag = latestGoGuidelinesTag(names)
      if (!tag) return { status: 'failed', error: 'no release tag found' }
      tagsEtag = response.headers.get('etag')?.slice(0, 200) ?? undefined
    }
    if (previous?.tag === tag) {
      const { tagsEtag: _old, ...rest } = previous
      return {
        status: 'unchanged',
        stored: { ...rest, checkedAt: now, ...(tagsEtag ? { tagsEtag } : {}) },
      }
    }
    const response = await fetcher(
      `https://raw.githubusercontent.com/${GO_GUIDELINES_REPOSITORY}/${tag}/${DATA_PATH}`,
      { headers: { 'user-agent': 'holtkeeper' }, signal },
    )
    if (!response.ok) return { status: 'failed', error: failure(response, `${tag} data`) }
    const length = Number(response.headers.get('content-length'))
    if (length > GO_GUIDELINES_MAX_BYTES)
      return { status: 'failed', error: `${tag} data is ${length} bytes, over the limit` }
    const guidelines = parseGoGuidelines(await response.text())
    return {
      status: 'updated',
      stored: {
        tag,
        fetchedAt: now,
        checkedAt: now,
        ...(tagsEtag ? { tagsEtag } : {}),
        count: guidelines.length,
        guidelines,
      },
    }
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
}
