import { z } from 'zod'

/** The subset of `fetch` the GitLab client uses; the global `fetch` satisfies it. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

/** A non-2xx answer from GitLab. The message carries the status and GitLab's own message, never the token. */
export class GitLabApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'GitLabApiError'
    this.status = status
  }
}

export function apiUrl(base: string, path: string): string {
  const url = new URL(base)
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/api/v4/${path}`
  url.search = ''
  url.hash = ''
  return url.toString()
}

const errorSchema = z
  .object({ message: z.unknown(), error: z.unknown(), error_description: z.unknown() })
  .partial()

export function gitlabMessage(body: unknown): string | undefined {
  const parsed = errorSchema.safeParse(body)
  if (!parsed.success) return undefined
  const { message, error, error_description: description } = parsed.data
  const value = message ?? description ?? error
  if (value === undefined) return undefined
  return typeof value === 'string' ? value : JSON.stringify(value)
}

export const encode = (value: string | number) => encodeURIComponent(String(value))

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'
type Query = Record<string, string | number | boolean | undefined>

interface RequestOptions {
  query?: Query
  body?: unknown
}

export interface GitLabClient {
  json<T>(method: Method, path: string, schema: z.ZodType<T>, init?: RequestOptions): Promise<T>
  text(method: Method, path: string, init?: RequestOptions): Promise<string>
  bytes(method: Method, path: string, init?: RequestOptions): Promise<Uint8Array>
  paginate<T>(path: string, schema: z.ZodType<T>, query?: Query): AsyncIterable<T>
}

export interface GitLabClientOptions {
  url: string
  token: string
  fetch: FetchLike
  retries: number
  perPage: number
}

const MAX_RETRY_DELAY_MS = 60_000

function retryDelay(header: string | null): number {
  if (!header) return 1000
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds, 0) * 1000, MAX_RETRY_DELAY_MS)
  const date = Date.parse(header)
  if (Number.isNaN(date)) return 1000
  return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_DELAY_MS)
}

function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : undefined
  } catch {
    return undefined
  }
}

function nextLink(header: string | null): string | undefined {
  if (!header) return undefined
  for (const part of header.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part)
    if (match) return match[1]
  }
  return undefined
}

const labelFor = (method: Method, url: string) => `GitLab ${method} ${new URL(url).pathname}`

const validate = <T>(schema: z.ZodType<T>, body: unknown, label: string, status: number) => {
  const parsed = schema.safeParse(body)
  if (parsed.success) return parsed.data
  const fields = parsed.error.issues.map((issue) => issue.path.join('.') || '(body)').join(', ')
  throw new GitLabApiError(status, `${label} returned an unexpected response (${fields})`)
}

/** HTTP client for GitLab REST v4 shared by the forge adapter. */
export function createGitLabClient(options: GitLabClientOptions): GitLabClient {
  const { token, retries, perPage } = options
  const fetchImpl = options.fetch
  const apiRoot = apiUrl(options.url, '')

  const redact = (value: string) => (token ? value.replaceAll(token, '[redacted]') : value)

  const send = async (method: Method, url: string, body: unknown, label: string) => {
    const headers: Record<string, string> = { 'PRIVATE-TOKEN': token, Accept: 'application/json' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    for (let attempt = 0; ; attempt++) {
      const response = await fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        // fetch keeps custom headers such as PRIVATE-TOKEN across cross-origin redirects.
        redirect: 'error',
      })
      if (response.status === 429 && attempt < retries) {
        await response.body?.cancel()
        const delay = retryDelay(response.headers.get('Retry-After'))
        await new Promise((resolve) => setTimeout(resolve, delay))
        continue
      }
      if (!response.ok) {
        const text = await response.text()
        const raw = gitlabMessage(parseJson(text)) ?? (response.statusText || 'no error message')
        throw new GitLabApiError(
          response.status,
          `${label} failed with ${response.status}: ${redact(raw).slice(0, 500)}`,
        )
      }
      return response
    }
  }

  const sendText = async (method: Method, url: string, body: unknown, label: string) => {
    const response = await send(method, url, body, label)
    return { response, text: await response.text() }
  }

  const buildUrl = (path: string, query: Query | undefined) => {
    const url = new URL(apiUrl(options.url, path))
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    return url.toString()
  }

  return {
    async json(method, path, schema, init = {}) {
      const url = buildUrl(path, init.query)
      const label = labelFor(method, url)
      const { response, text } = await sendText(method, url, init.body, label)
      return validate(schema, parseJson(text), label, response.status)
    },

    async text(method, path, init = {}) {
      const url = buildUrl(path, init.query)
      return (await sendText(method, url, init.body, labelFor(method, url))).text
    },

    async bytes(method, path, init = {}) {
      const url = buildUrl(path, init.query)
      const response = await send(method, url, init.body, labelFor(method, url))
      return new Uint8Array(await response.arrayBuffer())
    },

    async *paginate(path, schema, query = {}) {
      let url: string | undefined = buildUrl(path, { per_page: perPage, ...query })
      const pageSchema = z.array(schema)
      while (url) {
        const label = labelFor('GET', url)
        const { response, text } = await sendText('GET', url, undefined, label)
        yield* validate(pageSchema, parseJson(text), label, response.status)
        const link = nextLink(response.headers.get('Link'))
        if (link) {
          // The token goes wherever this URL points, so only follow links inside the API root.
          if (!link.startsWith(apiRoot)) {
            throw new GitLabApiError(response.status, `${label} returned a foreign next-page link`)
          }
          url = link
          continue
        }
        const nextPage = response.headers.get('X-Next-Page')
        if (!nextPage) break
        const next = new URL(url)
        next.searchParams.set('page', nextPage)
        url = next.toString()
      }
    },
  }
}
