/** Answers of the GitHub API that callers inspect besides the body. */
export interface GitHubResponse<T> {
  status: number
  data: T
  /** Value of `Link: <…>; rel="next"`, when there is a next page. */
  next?: string
}

/**
 * GitHub REST and GraphQL access. When a rate limit runs out, implementations move to another
 * token or wait for the reset (`X-RateLimit-Reset`, a secondary limit's `Retry-After`) up to
 * `maxWaitMs`, then throw `GitHubRateLimitError`.
 */
export interface GitHubClient {
  /** `path` starts with `/` or is a full `https://api.github.com/...` URL (for `next`). */
  rest<T = unknown>(path: string): Promise<GitHubResponse<T | undefined>>
  /**
   * The body of a `GET`, e.g. a tarball, as a stream; `undefined` for 404. The stream errors with
   * `DownloadTooLargeError` once more than `maxBytes` arrived (or up front, from `Content-Length`).
   */
  download(
    path: string,
    options: { maxBytes: number },
  ): Promise<ReadableStream<Uint8Array> | undefined>
  graphql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T>
  /** Whether requests carry a token; GraphQL needs one. */
  readonly authenticated: boolean
}

/** A download that went past its size limit. */
export class DownloadTooLargeError extends Error {
  readonly maxBytes: number
  constructor(what: string, maxBytes: number) {
    super(`${what} is larger than ${maxBytes} bytes`)
    this.name = 'DownloadTooLargeError'
    this.maxBytes = maxBytes
  }
}

/**
 * The body of `response`, failing with `DownloadTooLargeError` when `Content-Length` or the bytes
 * that arrive exceed `maxBytes`; the connection is cancelled then, so nothing more is read.
 */
export function limitStream(
  response: Response,
  maxBytes: number,
  what: string,
): ReadableStream<Uint8Array> {
  const declared = Number(response.headers.get('content-length'))
  if (declared > maxBytes) {
    void response.body?.cancel()
    throw new DownloadTooLargeError(what, maxBytes)
  }
  if (!response.body) return new Blob([]).stream()
  let received = 0
  return response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.length
        if (received > maxBytes) controller.error(new DownloadTooLargeError(what, maxBytes))
        else controller.enqueue(chunk)
      },
    }),
  )
}

export class GitHubRateLimitError extends Error {
  readonly resetAt: Date | undefined
  constructor(resetAt: Date | undefined) {
    super(`GitHub rate limit exhausted${resetAt ? ` until ${resetAt.toISOString()}` : ''}`)
    this.name = 'GitHubRateLimitError'
    this.resetAt = resetAt
  }
}

/** Where `ETag`s and the bodies they validate are kept between runs; `Store.kv` fits. */
export interface GitHubCache {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>
}

export interface GitHubClientOptions {
  /** One token; shorthand for `tokens: [token]`. */
  token?: string
  /**
   * Tokens shared by every request: each goes to the token with the most of that request's rate
   * limit left (`core`, `search` and `graphql` are counted apart). Tokens of the same account
   * share one limit on GitHub's side, so duplicates are found once (`GET /user`) and dropped.
   */
  tokens?: string[]
  fetch?: typeof fetch
  /** Default `https://api.github.com`. */
  apiUrl?: string
  /**
   * Longest wait for a rate limit to reset when every token is exhausted, before throwing
   * `GitHubRateLimitError`. Default 60 s; the primary limit resets within an hour.
   */
  maxWaitMs?: number
  /** Conditional requests: `GET`s send `If-None-Match`, and a `304` (free on GitHub's side) answers from here. */
  cache?: GitHubCache
  /** How long a cached body is kept. Default 30 days. */
  cacheTtlSeconds?: number
  /** Aborts requests and waits. */
  signal?: AbortSignal
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
  log?: (line: string) => void
  /** Told about every answer and every wait, e.g. to count use per token. */
  onEvent?: (event: GitHubEvent) => void
}

/** The API resources GitHub counts rate limits for separately. */
export type GitHubResource = 'core' | 'search' | 'graphql'

/**
 * What the client did. `token` is the index of the token in `tokens` (after `token`), absent for
 * anonymous requests.
 */
export type GitHubEvent =
  | {
      kind: 'request'
      token?: number
      resource: GitHubResource
      status: number
      /** Answered `304` from the cache. */
      notModified: boolean
      /** The answer was a rate limit. */
      limited: boolean
    }
  | { kind: 'wait'; resource: GitHubResource; ms: number }

const nextLink = (header: string | null) =>
  header
    ?.split(',')
    .find((part) => part.includes('rel="next"'))
    ?.match(/<([^>]+)>/)?.[1]

const abortableSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })

type Resource = GitHubResource

interface Bucket {
  remaining?: number
  /** Epoch ms when `remaining` resets, or a secondary limit's `Retry-After` ends. */
  resetAt?: number
  blockedUntil?: number
}

interface PoolToken {
  token: string | undefined
  index?: number
  buckets: Map<Resource, Bucket>
}

interface CachedBody {
  etag: string
  data: unknown
  next?: string
}

const isCachedBody = (value: unknown): value is CachedBody =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { etag?: unknown }).etag === 'string' &&
  'data' in value

const headers = (token: string | undefined, accept: string): Record<string, string> => ({
  accept,
  'user-agent': 'holtkeeper',
  'x-github-api-version': '2022-11-28',
  ...(token ? { authorization: `Bearer ${token}` } : {}),
})

const resourceOf = (url: string): Resource =>
  url.includes('/graphql') ? 'graphql' : url.includes('/search/') ? 'search' : 'core'

/** A `GitHubClient` over `fetch`. */
export function createGitHubClient(options: GitHubClientOptions = {}): GitHubClient {
  const doFetch = options.fetch ?? fetch
  const apiUrl = (options.apiUrl ?? 'https://api.github.com').replace(/\/$/, '')
  const maxWaitMs = options.maxWaitMs ?? 60_000
  const sleep = options.sleep ?? abortableSleep
  const now = options.now ?? Date.now
  const ttl = options.cacheTtlSeconds ?? 30 * 86_400
  const given = [...new Set([...(options.tokens ?? []), ...(options.token ? [options.token] : [])])]
  let pool: PoolToken[] = given.length
    ? given.map((token, index) => ({ token, index, buckets: new Map() }))
    : [{ token: undefined, buckets: new Map() }]
  const urlOf = (path: string) => (path.startsWith('http') ? path : `${apiUrl}${path}`)

  let identified: Promise<void> | undefined
  const identify = () =>
    (identified ??= (async () => {
      if (pool.length < 2) return
      const accounts = await Promise.all(
        pool.map(async ({ token }) => {
          try {
            const response = await doFetch(`${apiUrl}/user`, {
              headers: headers(token, 'application/vnd.github+json'),
              ...(options.signal ? { signal: options.signal } : {}),
            })
            if (!response.ok) return undefined
            const body: unknown = await response.json()
            if (typeof body !== 'object' || body === null || !('login' in body)) return undefined
            return typeof body.login === 'string' ? body.login : undefined
          } catch {
            return undefined
          }
        }),
      )
      const seen = new Set<string>()
      const kept: PoolToken[] = []
      pool.forEach((entry, index) => {
        const account = accounts[index]
        if (account && seen.has(account)) {
          options.log?.(
            `github: two tokens belong to ${account}; they share one rate limit, so one is dropped`,
          )
          return
        }
        if (account) seen.add(account)
        kept.push(entry)
      })
      pool = kept
    })())

  const bucket = (entry: PoolToken, resource: Resource) => {
    let found = entry.buckets.get(resource)
    if (!found) entry.buckets.set(resource, (found = {}))
    return found
  }

  /** When this token can next serve the resource; `0` for now. */
  const readyAt = (entry: PoolToken, resource: Resource) => {
    const state = bucket(entry, resource)
    const at = now()
    if (state.blockedUntil && state.blockedUntil > at) return state.blockedUntil
    if (state.remaining === 0 && state.resetAt && state.resetAt > at) return state.resetAt
    return 0
  }

  const pick = (resource: Resource) => {
    const ready = pool.filter((entry) => readyAt(entry, resource) === 0)
    if (ready.length)
      return ready.reduce((best, entry) =>
        (bucket(entry, resource).remaining ?? Infinity) >
        (bucket(best, resource).remaining ?? Infinity)
          ? entry
          : best,
      )
    return undefined
  }

  const record = (entry: PoolToken, resource: Resource, response: Response) => {
    const state = bucket(entry, resource)
    const remaining = Number(response.headers.get('x-ratelimit-remaining'))
    const reset = Number(response.headers.get('x-ratelimit-reset'))
    if (response.headers.has('x-ratelimit-remaining') && Number.isFinite(remaining))
      state.remaining = remaining
    if (Number.isFinite(reset) && reset > 0) state.resetAt = reset * 1000
  }

  const send = async (
    url: string,
    init: (token: string | undefined) => RequestInit,
  ): Promise<Response> => {
    await identify()
    const resource = resourceOf(url)
    for (let attempt = 0; attempt < pool.length * 3 + 3; attempt++) {
      options.signal?.throwIfAborted()
      const entry = pick(resource)
      if (!entry) {
        const next = Math.min(...pool.map((candidate) => readyAt(candidate, resource)))
        const waitMs = next - now()
        if (waitMs > maxWaitMs) throw new GitHubRateLimitError(new Date(next))
        options.log?.(
          `github: ${resource} rate limit exhausted; waiting ${Math.ceil(waitMs / 1000)} s until ${new Date(next).toISOString()}`,
        )
        options.onEvent?.({ kind: 'wait', resource, ms: Math.max(0, waitMs) })
        // oxlint-disable-next-line no-await-in-loop -- waiting for the limit to reset is the point
        await sleep(Math.max(0, waitMs), options.signal)
        continue
      }
      // oxlint-disable-next-line no-await-in-loop -- retries are sequential by nature
      const response = await doFetch(url, {
        ...init(entry.token),
        ...(options.signal ? { signal: options.signal } : {}),
      })
      record(entry, resource, response)
      const primary =
        (response.status === 403 || response.status === 429) &&
        response.headers.get('x-ratelimit-remaining') === '0'
      const retryAfter = Number(response.headers.get('retry-after'))
      const secondary =
        !primary &&
        (response.status === 429 ||
          (response.status === 403 && Number.isFinite(retryAfter) && retryAfter > 0))
      options.onEvent?.({
        kind: 'request',
        ...(entry.index === undefined ? {} : { token: entry.index }),
        resource,
        status: response.status,
        notModified: response.status === 304,
        limited: primary || secondary,
      })
      if (!primary && !secondary) return response
      void response.body?.cancel()
      const state = bucket(entry, resource)
      if (primary) state.remaining = 0
      else state.blockedUntil = now() + (retryAfter > 0 ? retryAfter * 1000 : 60_000)
    }
    const next = Math.min(...pool.map((candidate) => readyAt(candidate, resource)))
    throw new GitHubRateLimitError(next > 0 ? new Date(next) : undefined)
  }

  return {
    authenticated: given.length > 0,
    // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- implements the generic interface method
    async rest<T>(path: string) {
      const url = urlOf(path)
      const key = `github:etag:${url}`
      const stored = options.cache ? await options.cache.get(key) : undefined
      const cached = isCachedBody(stored) ? stored : undefined
      const response = await send(url, (token) => ({
        headers: {
          ...headers(token, 'application/vnd.github+json'),
          ...(cached ? { 'if-none-match': cached.etag } : {}),
        },
      }))
      if (response.status === 304 && cached)
        return {
          status: 200,
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the cached body is the one the same path returned before
          data: cached.data as T,
          ...(cached.next ? { next: cached.next } : {}),
        }
      if (response.status === 404) return { status: 404, data: undefined }
      if (!response.ok) throw new Error(`GitHub ${response.status} for ${path}`)
      const next = nextLink(response.headers.get('link'))
      const data: unknown = await response.json()
      const etag = response.headers.get('etag')
      if (options.cache && etag)
        await options.cache.set(key, { etag, data, ...(next ? { next } : {}) }, ttl)
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- callers name the shape of the endpoint they call
      return { status: response.status, data: data as T, ...(next ? { next } : {}) }
    },
    async download(path, { maxBytes }) {
      const response = await send(urlOf(path), (token) => ({
        headers: headers(token, 'application/octet-stream'),
      }))
      if (response.status === 404) return undefined
      if (!response.ok) throw new Error(`GitHub ${response.status} for ${path}`)
      return limitStream(response, maxBytes, path)
    },
    async graphql<T>(query: string, variables: Record<string, unknown> = {}) {
      if (!given.length) throw new Error('GitHub GraphQL needs a token')
      const response = await send(`${apiUrl}/graphql`, (token) => ({
        method: 'POST',
        headers: { ...headers(token, 'application/json'), 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      }))
      if (!response.ok) throw new Error(`GitHub GraphQL ${response.status}`)
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the query decides the shape
      const body = (await response.json()) as { data?: T; errors?: { message: string }[] }
      if (body.errors?.length) throw new Error(`GitHub GraphQL: ${body.errors[0]?.message}`)
      if (body.data === undefined) throw new Error('GitHub GraphQL returned no data')
      return body.data
    },
  }
}

/** What GitHub says about one token: its account and live limits by resource. */
export interface GitHubTokenInfo {
  login?: string
  limits?: Record<string, { limit: number; used: number; remaining: number; resetAt: string }>
  error?: string
}

/**
 * The account (`GET /user`) and the live limits (`GET /rate_limit`, which GitHub does not count)
 * of `token`; anonymous without one. Never throws: problems come back as `error`.
 */
export async function githubTokenInfo(
  token: string | undefined,
  options: { fetch?: typeof fetch; apiUrl?: string; signal?: AbortSignal } = {},
): Promise<GitHubTokenInfo> {
  const doFetch = options.fetch ?? fetch
  const apiUrl = (options.apiUrl ?? 'https://api.github.com').replace(/\/$/, '')
  const get = (path: string) =>
    doFetch(`${apiUrl}${path}`, {
      headers: headers(token, 'application/vnd.github+json'),
      ...(options.signal ? { signal: options.signal } : {}),
    })
  try {
    const [user, limits] = await Promise.all([token ? get('/user') : undefined, get('/rate_limit')])
    if (limits.status === 401 || user?.status === 401) return { error: 'GitHub rejected the token' }
    if (!limits.ok) return { error: `GitHub ${limits.status} for /rate_limit` }
    const body: unknown = await limits.json()
    const resources =
      typeof body === 'object' && body !== null && 'resources' in body ? body.resources : undefined
    const info: GitHubTokenInfo = { limits: {} }
    if (typeof resources === 'object' && resources !== null)
      for (const [name, value] of Object.entries(resources)) {
        if (typeof value !== 'object' || value === null) continue
        const limit: unknown = 'limit' in value ? value.limit : undefined
        const used: unknown = 'used' in value ? value.used : undefined
        const remaining: unknown = 'remaining' in value ? value.remaining : undefined
        const reset: unknown = 'reset' in value ? value.reset : undefined
        if (typeof limit !== 'number' || typeof remaining !== 'number') continue
        info.limits![name] = {
          limit,
          used: typeof used === 'number' ? used : limit - remaining,
          remaining,
          resetAt: new Date((typeof reset === 'number' ? reset : 0) * 1000).toISOString(),
        }
      }
    if (user?.ok) {
      const account: unknown = await user.json()
      if (typeof account === 'object' && account !== null && 'login' in account)
        if (typeof account.login === 'string') info.login = account.login
    }
    return info
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}
