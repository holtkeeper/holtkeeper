/**
 * A non-2xx answer (or a malformed 2xx one) of an OpenAI-format endpoint. `message` is the API's
 * own error message (the API key is never part of it), `status` the HTTP status and `code` the
 * API's error code when it sends one (`model_not_found`, `invalid_api_key`, ...).
 */
export class EmbeddingError extends Error {
  readonly status: number
  readonly code: string | undefined

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'EmbeddingError'
    this.status = status
    this.code = code
  }
}

/** What every request needs: where, with which key, through which `fetch`. */
export interface HttpOptions {
  url: string
  apiKey: string
  fetch?: typeof fetch | undefined
}

/** Whether `value` is a non-null object whose fields can be read. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const RETRIES = 2
const MAX_WAIT_MS = 60_000

const retryable = (status: number) => status === 429 || status >= 500

/** Milliseconds `Retry-After` asks for (seconds or an HTTP date), capped; undefined when absent. */
function retryAfter(header: string | null): number | undefined {
  if (!header?.trim()) return undefined
  const seconds = Number(header)
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now()
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), MAX_WAIT_MS) : undefined
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const done = () => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }
    const timer = setTimeout(done, ms)
    const abort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

const redact = (text: string, secret: string) => (secret ? text.split(secret).join('***') : text)

async function errorOf(response: Response, apiKey: string): Promise<EmbeddingError> {
  const text = await response.text().catch(() => '')
  let message: string | undefined
  let code: string | undefined
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    // Not JSON: a proxy's HTML or plain text; its start is the best message there is.
  }
  const error = isRecord(body) ? body.error : undefined
  if (typeof error === 'string') message = error
  else if (isRecord(error)) {
    if (typeof error.message === 'string') message = error.message
    if (typeof error.code === 'string') code = error.code
    else if (typeof error.type === 'string') code = error.type
  }
  message ??= text.trim().slice(0, 300) || `HTTP ${response.status} ${response.statusText}`.trim()
  return new EmbeddingError(response.status, redact(message, apiKey), code)
}

/**
 * Sends `init` to `{url}{path}` with the key as a bearer token and returns the parsed JSON body.
 * 429 and 5xx answers are retried twice, waiting what `Retry-After` asks (else 1 s, then 2 s);
 * other non-2xx answers, and the last failed retry, throw an `EmbeddingError`.
 */
export async function requestJson(
  options: HttpOptions,
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal | undefined },
): Promise<unknown> {
  const doFetch = options.fetch ?? fetch
  const target = `${options.url.replace(/\/+$/, '')}${path}`
  for (let attempt = 0; ; attempt++) {
    // oxlint-disable-next-line no-await-in-loop -- retries wait for the previous answer
    const response = await doFetch(target, {
      method: init.method,
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        accept: 'application/json',
        ...(init.body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
      ...(init.signal && { signal: init.signal }),
    })
    if (response.ok) {
      // oxlint-disable-next-line no-await-in-loop -- the loop ends here
      const text = await response.text()
      try {
        return JSON.parse(text)
      } catch {
        throw new EmbeddingError(response.status, 'the response is not JSON', 'invalid_response')
      }
    }
    if (!retryable(response.status) || attempt >= RETRIES) {
      // oxlint-disable-next-line no-await-in-loop -- the loop ends here
      throw await errorOf(response, options.apiKey)
    }
    const wait = retryAfter(response.headers.get('retry-after')) ?? 1000 * 2 ** attempt
    // Drain the body so the connection can be reused.
    // oxlint-disable-next-line no-await-in-loop -- see above
    await response.body?.cancel().catch(() => {})
    // oxlint-disable-next-line no-await-in-loop -- retries wait for the previous answer
    await sleep(wait, init.signal)
  }
}
