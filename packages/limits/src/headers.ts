/** Response headers as `Headers` or a plain record (as SDK errors often expose them). */
export type HeadersLike =
  | Headers
  | Record<string, string | readonly string[] | number | null | undefined>

/** What a rate-limit answer said about when to try again. */
export interface ThrottleHint {
  /** Wait this long before the next request; omitted when the answer had no usable hint. */
  delayMs?: number
}

const lookup = (headers: HeadersLike) => {
  if (headers instanceof Headers) return (name: string) => headers.get(name) ?? undefined
  const lowered = new Map<string, string>()
  for (const [name, value] of Object.entries(headers)) {
    if (value === null || value === undefined) continue
    const text = Array.isArray(value) ? value[0] : String(value)
    if (text !== undefined) lowered.set(name.toLowerCase(), text)
  }
  return (name: string) => lowered.get(name)
}

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }

/** `1.5`, `6m0s`, `20ms`, `1h2m` → milliseconds; plain numbers are seconds. */
function parseDuration(text: string): number | undefined {
  const trimmed = text.trim()
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed) * 1000
  const parts = [...trimmed.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)]
  if (parts.length === 0 || parts.map((part) => part[0]).join('') !== trimmed) return undefined
  return parts.reduce((sum, [, value, unit]) => sum + Number(value) * (UNITS[unit ?? 's'] ?? 0), 0)
}

const untilDate = (text: string, now: number) => {
  const at = Date.parse(text)
  return Number.isNaN(at) ? undefined : at - now
}

function parseRetryAfter(text: string, now: number) {
  const seconds = Number(text.trim())
  return Number.isFinite(seconds) ? seconds * 1000 : untilDate(text, now)
}

/** `x-ratelimit-reset`/`ratelimit-reset`: epoch seconds (GitLab, GitHub), a delta or a duration. */
function parseReset(text: string, now: number) {
  const value = Number(text.trim())
  if (Number.isFinite(value)) return value > 1e9 ? value * 1000 - now : value * 1000
  return parseDuration(text) ?? untilDate(text, now)
}

const ANTHROPIC = ['requests', 'tokens', 'input-tokens', 'output-tokens']

const clamp = (value: number | undefined) =>
  value === undefined || Number.isNaN(value) ? undefined : Math.max(0, Math.ceil(value))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object'

const isHeadersLike = (value: unknown): value is HeadersLike =>
  value instanceof Headers ||
  (isRecord(value) &&
    Object.values(value).every(
      (entry) =>
        entry === null ||
        entry === undefined ||
        typeof entry === 'string' ||
        typeof entry === 'number' ||
        Array.isArray(entry),
    ))

/**
 * How long to wait according to rate-limit headers, in ms (never negative): `retry-after-ms`,
 * `Retry-After` (seconds or HTTP date) first; otherwise the latest of `ratelimit-reset`,
 * `x-ratelimit-reset*` and the exhausted `anthropic-ratelimit-*-reset` headers. `undefined` when
 * none is present or parseable.
 */
export function retryDelayFrom(headers: HeadersLike, now: number): number | undefined {
  const get = lookup(headers)

  const ms = get('retry-after-ms')
  if (ms !== undefined && Number.isFinite(Number(ms))) return clamp(Number(ms))
  const after = get('retry-after')
  if (after !== undefined) {
    const delay = clamp(parseRetryAfter(after, now))
    if (delay !== undefined) return delay
  }

  const hints: number[] = []
  const add = (value: number | undefined) => {
    const delay = clamp(value)
    if (delay !== undefined) hints.push(delay)
  }
  for (const name of [
    'ratelimit-reset',
    'x-ratelimit-reset',
    'x-ratelimit-reset-requests',
    'x-ratelimit-reset-tokens',
  ]) {
    const value = get(name)
    if (value !== undefined) add(parseReset(value, now))
  }
  for (const family of ANTHROPIC) {
    const reset = get(`anthropic-ratelimit-${family}-reset`)
    if (reset === undefined) continue
    const remaining = get(`anthropic-ratelimit-${family}-remaining`)
    if (remaining !== undefined && Number(remaining) > 0) continue
    add(untilDate(reset, now))
  }
  return hints.length > 0 ? Math.max(...hints) : undefined
}

const RATE_LIMIT_TEXT = /rate[ _-]?limit|too many requests/i

const field = (value: unknown, name: string): unknown => (isRecord(value) ? value[name] : undefined)

/**
 * Recognizes a rate-limit failure thrown by an AI SDK or HTTP client: a `status`/`statusCode` in
 * `onStatus`, an error `type` of `rate_limit_error`, or a message mentioning a rate limit. Returns
 * the retry hint from the error's `headers` when it has them, `undefined` when it is no rate limit.
 */
export function throttleHintFrom(
  error: unknown,
  onStatus: readonly number[],
  now: number,
): ThrottleHint | undefined {
  const status = field(error, 'status') ?? field(error, 'statusCode')
  const type = field(error, 'type') ?? field(field(error, 'error'), 'type')
  const message = error instanceof Error ? error.message : String(error)
  const limited =
    (typeof status === 'number' && onStatus.includes(status)) ||
    type === 'rate_limit_error' ||
    RATE_LIMIT_TEXT.test(message)
  if (!limited) return undefined
  const headers = field(error, 'headers') ?? field(field(error, 'response'), 'headers')
  if (!isHeadersLike(headers)) return {}
  const delayMs = retryDelayFrom(headers, now)
  return delayMs === undefined ? {} : { delayMs }
}
