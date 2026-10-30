import type { z } from 'zod'

import { ConfluenceApiError } from './errors.ts'

/** The subset of `fetch` the client uses; the global `fetch` satisfies it. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

type Method = 'GET' | 'PUT'

export interface ConfluenceClient {
  json<T>(method: Method, url: string, schema: z.ZodType<T>, body?: unknown): Promise<T>
}

export interface ConfluenceClientOptions {
  authorization: () => string
  /** Values that must never appear in error messages. */
  secrets: () => string[]
  fetch: FetchLike
  retries: number
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Confluence's own error text: v2 `{ errors: [{ title, detail }] }` or v1 `{ message }`. */
function confluenceMessage(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined
  if (Array.isArray(body.errors)) {
    const parts = body.errors
      .filter(isRecord)
      .map((error) =>
        [error.title, error.detail]
          .filter((part) => typeof part === 'string' && part !== '')
          .join(': '),
      )
      .filter((part) => part !== '')
    if (parts.length > 0) return parts.join('; ')
  }
  if (typeof body.message === 'string' && body.message !== '') return body.message
  return undefined
}

/** JSON-over-HTTP client for one Confluence site; refuses redirects so credentials stay on its host. */
export function createConfluenceClient(options: ConfluenceClientOptions): ConfluenceClient {
  const redact = (value: string) =>
    options
      .secrets()
      .reduce((text, secret) => (secret ? text.replaceAll(secret, '[redacted]') : text), value)

  return {
    async json<T>(method: Method, url: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
      const label = `Confluence ${method} ${new URL(url).pathname}`
      const headers: Record<string, string> = {
        Authorization: options.authorization(),
        Accept: 'application/json',
      }
      if (body !== undefined) headers['Content-Type'] = 'application/json'
      const send = async (attempt: number): Promise<T> => {
        let response: Response
        try {
          response = await options.fetch(url, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            // fetch keeps the Authorization header across redirects to other hosts.
            redirect: 'error',
          })
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          throw new ConfluenceApiError(0, `${label} failed: ${redact(reason).slice(0, 500)}`)
        }
        if (response.status === 429 && attempt < options.retries) {
          await response.body?.cancel()
          await Bun.sleep(retryDelay(response.headers.get('Retry-After')))
          return send(attempt + 1)
        }
        const text = await response.text()
        if (!response.ok) {
          const raw =
            confluenceMessage(parseJson(text)) ?? (response.statusText || 'no error message')
          throw new ConfluenceApiError(
            response.status,
            `${label} failed with ${response.status}: ${redact(raw).slice(0, 500)}`,
          )
        }
        const parsed = schema.safeParse(parseJson(text))
        if (parsed.success) return parsed.data
        const fields = parsed.error.issues
          .map((issue) => issue.path.join('.') || '(body)')
          .join(', ')
        throw new ConfluenceApiError(
          response.status,
          `${label} returned an unexpected response (${fields})`,
        )
      }
      return send(0)
    },
  }
}
