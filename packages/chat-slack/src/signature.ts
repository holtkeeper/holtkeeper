import { createHmac, timingSafeEqual } from 'node:crypto'

export interface SlackRequestCheck {
  signingSecret: string
  /** `X-Slack-Request-Timestamp`, seconds since the epoch. */
  timestamp: string | undefined
  /** `X-Slack-Signature`, `v0=<hex>`. */
  signature: string | undefined
  /** The raw request body, exactly as received. */
  body: string
  now?: Date
  /** Oldest accepted request; default five minutes, as Slack recommends. */
  toleranceSeconds?: number
}

/**
 * Whether a request came from Slack: `v0=HMAC-SHA256(secret, "v0:<timestamp>:<body>")`, compared
 * in constant time, with a timestamp within the tolerance of `now` so old requests cannot be
 * replayed.
 */
export function verifySlackRequest(check: SlackRequestCheck): boolean {
  const { timestamp, signature } = check
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false
  const now = (check.now ?? new Date()).getTime() / 1000
  if (Math.abs(now - Number(timestamp)) > (check.toleranceSeconds ?? 300)) return false
  const expected = `v0=${createHmac('sha256', check.signingSecret)
    .update(`v0:${timestamp}:${check.body}`)
    .digest('hex')}`
  const given = Buffer.from(signature)
  const wanted = Buffer.from(expected)
  return given.length === wanted.length && timingSafeEqual(given, wanted)
}

/** Signs a body like Slack does; for tests and local tools. */
export const signSlackRequest = (signingSecret: string, timestamp: string, body: string) =>
  `v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:${body}`).digest('hex')}`
