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

/**
 * Sends one JSON-RPC request to the MCP endpoint (`/mcp`) with the session cookie and returns its
 * `result`. Throws `ApiError` for HTTP and JSON-RPC errors.
 */
export async function mcpRequest<T>(method: string, params?: unknown): Promise<T> {
  const response = await fetch('/mcp', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      ...(params === undefined ? {} : { params }),
    }),
  })
  const body: unknown = await response.json().catch(() => undefined)
  if (typeof body === 'object' && body !== null) {
    if ('error' in body && typeof body.error === 'object' && body.error !== null)
      throw new ApiError(
        response.ok ? 500 : response.status,
        'message' in body.error && typeof body.error.message === 'string'
          ? body.error.message
          : 'MCP request failed',
      )
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    if (response.ok && 'result' in body) return body.result as T
  }
  throw new ApiError(
    response.status,
    response.statusText || `Request failed with ${response.status}`,
  )
}

/** Sends a JSON request like `request` and returns the response body as a file download. */
export async function requestBlob(
  method: 'GET' | 'POST',
  path: string,
  options: { body?: unknown; query?: Query } = {},
): Promise<Blob> {
  const response = await fetch(withQuery(path, options.query), {
    method,
    credentials: 'same-origin',
    ...(options.body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(options.body) }),
  })
  if (!response.ok) throw new ApiError(response.status, await errorMessage(response))
  return response.blob()
}

/** A same-origin URL with query parameters, for links and downloads. */
export const urlOf = (path: string, query?: Query): string => withQuery(path, query)

/** Sends `file` as the raw request body with its own content type; parses a JSON answer. */
export async function uploadFile<T>(
  method: 'POST' | 'PUT',
  path: string,
  file: Blob,
  query?: Query,
): Promise<T> {
  const response = await fetch(withQuery(path, query), {
    method,
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      'content-type': file.type || 'application/octet-stream',
    },
    body: file,
  })
  if (!response.ok) throw new ApiError(response.status, await errorMessage(response))
  // The server is the trust boundary: its responses follow the shared `@holtkeeper/api` types.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return (await response.json()) as T
}

/** Human message for any thrown value. */
export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** Whether the error is a 403 from the server, i.e. the principal lacks access. */
export const isForbidden = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 403
