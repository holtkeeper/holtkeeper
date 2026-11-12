import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

/** Requests signed longer ago than this are refused, so a captured request cannot be replayed. */
export const SLACK_SIGNATURE_MAX_AGE_SECONDS = 5 * 60

/** The `X-Slack-Signature` Slack sends for `body` at `timestamp` (seconds) with `signingSecret`. */
export const slackSignature = (signingSecret: string, timestamp: string, body: string) =>
  `v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:${body}`).digest('hex')}`

const digest = (value: string) => createHash('sha256').update(value).digest()

/**
 * Whether a request comes from Slack: a `v0` HMAC-SHA256 of `v0:<timestamp>:<raw body>` with the
 * app's signing secret, compared in constant time, and a timestamp within five minutes of `now`
 * either way.
 */
export function verifySlackSignature(input: {
  signingSecret: string
  timestamp: string | undefined
  signature: string | undefined
  body: string
  now: Date
}): boolean {
  const { timestamp, signature } = input
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false
  const age = Math.abs(input.now.getTime() / 1000 - Number(timestamp))
  if (age > SLACK_SIGNATURE_MAX_AGE_SECONDS) return false
  const expected = slackSignature(input.signingSecret, timestamp, input.body)
  return timingSafeEqual(digest(signature), digest(expected))
}
