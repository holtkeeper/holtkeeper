import type { ApiError as ApiErrorBody } from '@holtkeeper/api'

/** A non-2xx response. `status` is the HTTP status; `message` the server's `error` text. */
export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

type Query = Record<string, string | number | undefined>

function withQuery(path: string, query?: Query): string {
  if (!query) return path
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, String(value))
  }
  const text = params.toString()
  return text ? `${path}?${text}` : path
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json()
    if (
      typeof body === 'object' &&
      body !== null &&
      'error' in body &&
      typeof body.error === 'string'
    ) {
      return body.error satisfies ApiErrorBody['error']
    }
  } catch {
    // Not JSON; fall through to the status text.
  }
  return response.statusText || `Request failed with ${response.status}`
}

/**
 * Sends a JSON request with the session cookie and returns the parsed body, or `undefined` for
 * 204 responses. Throws `ApiError` for non-2xx responses.
 */
export async function request<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  options: { body?: unknown; query?: Query; signal?: AbortSignal } = {},
): Promise<T> {
  const response = await fetch(withQuery(path, options.query), {
    method,
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.signal ? { signal: options.signal } : {}),
  })
  if (!response.ok) throw new ApiError(response.status, await errorMessage(response))
  const text = response.status === 204 ? '' : await response.text()
  // The server is the trust boundary: its responses follow the shared `@holtkeeper/api` types.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return (text ? JSON.parse(text) : undefined) as T
}

/** Human message for any thrown value. */
export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** Whether the error is a 403 from the server, i.e. the principal lacks access. */
export const isForbidden = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 403
