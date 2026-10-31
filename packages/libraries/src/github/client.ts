/** Answers of the GitHub API that callers inspect besides the body. */
export interface GitHubResponse<T> {
  status: number
  data: T
  /** Value of `Link: <…>; rel="next"`, when there is a next page. */
  next?: string
}

/**
 * GitHub REST and GraphQL access. Implementations wait out rate limits (`Retry-After`,
 * `X-RateLimit-Reset`) up to `maxWaitMs` and then throw `GitHubRateLimitError`.
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

export interface GitHubClientOptions {
  token?: string
  fetch?: typeof fetch
  /** Default `https://api.github.com`. */
  apiUrl?: string
  /** Longest wait for a rate limit reset before giving up. Default 60 s. */
  maxWaitMs?: number
  sleep?: (ms: number) => Promise<void>
}

const nextLink = (header: string | null) =>
  header
    ?.split(',')
    .find((part) => part.includes('rel="next"'))
    ?.match(/<([^>]+)>/)?.[1]

/** A `GitHubClient` over `fetch`. */
export function createGitHubClient(options: GitHubClientOptions = {}): GitHubClient {
  const doFetch = options.fetch ?? fetch
  const apiUrl = (options.apiUrl ?? 'https://api.github.com').replace(/\/$/, '')
  const maxWaitMs = options.maxWaitMs ?? 60_000
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms))
  const headers = (accept: string): Record<string, string> => ({
    accept,
    'user-agent': 'holtkeeper',
    'x-github-api-version': '2022-11-28',
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
  })
  const urlOf = (path: string) => (path.startsWith('http') ? path : `${apiUrl}${path}`)

  const send = async (url: string, init: RequestInit): Promise<Response> => {
    for (let attempt = 0; ; attempt++) {
      // oxlint-disable-next-line no-await-in-loop -- retries are sequential by nature
      const response = await doFetch(url, init)
      const limited =
        response.status === 429 ||
        (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')
      if (!limited) return response
      const retryAfter = Number(response.headers.get('retry-after'))
      const reset = Number(response.headers.get('x-ratelimit-reset'))
      const resetAt = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : undefined
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : resetAt
            ? resetAt.getTime() - Date.now()
            : 60_000
      if (attempt > 0 || waitMs > maxWaitMs) throw new GitHubRateLimitError(resetAt)
      // oxlint-disable-next-line no-await-in-loop -- see above
      await sleep(Math.max(0, waitMs))
    }
  }

  return {
    authenticated: options.token !== undefined,
    // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- implements the generic interface method
    async rest<T>(path: string) {
      const response = await send(urlOf(path), { headers: headers('application/vnd.github+json') })
      if (response.status === 404) return { status: 404, data: undefined }
      if (!response.ok) throw new Error(`GitHub ${response.status} for ${path}`)
      const next = nextLink(response.headers.get('link'))
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- callers name the shape of the endpoint they call
      const data = (await response.json()) as T
      return { status: response.status, data, ...(next ? { next } : {}) }
    },
    async download(path, { maxBytes }) {
      const response = await send(urlOf(path), { headers: headers('application/octet-stream') })
      if (response.status === 404) return undefined
      if (!response.ok) throw new Error(`GitHub ${response.status} for ${path}`)
      return limitStream(response, maxBytes, path)
    },
    async graphql<T>(query: string, variables: Record<string, unknown> = {}) {
      if (!options.token) throw new Error('GitHub GraphQL needs a token')
      const response = await send(`${apiUrl}/graphql`, {
        method: 'POST',
        headers: { ...headers('application/json'), 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      })
      if (!response.ok) throw new Error(`GitHub GraphQL ${response.status}`)
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the query decides the shape
      const body = (await response.json()) as { data?: T; errors?: { message: string }[] }
      if (body.errors?.length) throw new Error(`GitHub GraphQL: ${body.errors[0]?.message}`)
      if (body.data === undefined) throw new Error('GitHub GraphQL returned no data')
      return body.data
    },
  }
}
