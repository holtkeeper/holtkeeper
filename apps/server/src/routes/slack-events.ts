import { randomUUID } from 'node:crypto'

import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import type { Env, ServerDeps } from '../context.ts'
import { slackConnection } from '../slack/connection.ts'
import {
  type SlackMessage,
  type SlackReviews,
  createSlackReviews,
  newMergeRequestLinks,
} from '../slack/service.ts'
import { SLACK_SIGNATURE_MAX_AGE_SECONDS, verifySlackSignature } from '../slack/signature.ts'

/** How long an event id is remembered to drop Slack's retries of it. */
const EVENT_MEMORY_SECONDS = 60 * 60

const LOCAL_EVENT_MEMORY = 1000

/** Slack event payloads are small; anything larger is refused before it is read. */
const MAX_BODY_BYTES = 1024 * 1024

const handledSubtypes = new Set<string | undefined>([undefined, 'thread_broadcast', 'file_share'])

const handledChannelTypes = new Set<string | undefined>([undefined, 'channel', 'group'])

const innerMessageSchema = z.object({
  type: z.string().optional(),
  subtype: z.string().optional(),
  ts: z.string().optional(),
  text: z.string().optional(),
  bot_id: z.string().optional(),
})

const messageEventSchema = innerMessageSchema.extend({
  type: z.literal('message'),
  channel: z.string(),
  channel_type: z.string().optional(),
  message: innerMessageSchema.optional(),
  previous_message: innerMessageSchema.optional(),
})

const envelopeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('url_verification'), challenge: z.string() }),
  z.object({
    type: z.literal('event_callback'),
    event_id: z.string().optional(),
    event: z.looseObject({ type: z.string() }),
  }),
])

const isPlainMessage = (message: z.infer<typeof innerMessageSchema>) =>
  handledSubtypes.has(message.subtype) && message.bot_id === undefined

/**
 * The message an event asks to look at, or `undefined` for events the review status ignores:
 * other event types, direct messages, bot messages and subtypes other than plain messages,
 * thread broadcasts and file shares. An edit (`message_changed`) yields the new text with the
 * old one as `previousText`, so only links it added are handled.
 */
export function slackMessageOf(event: unknown): SlackMessage | undefined {
  const parsed = messageEventSchema.safeParse(event)
  if (!parsed.success) return undefined
  const message = parsed.data
  if (!handledChannelTypes.has(message.channel_type)) return undefined
  if (message.subtype === 'message_changed') {
    const edited = message.message
    if (!edited?.ts || edited.text === undefined || !isPlainMessage(edited)) return undefined
    return {
      channel: message.channel,
      ts: edited.ts,
      text: edited.text,
      previousText: message.previous_message?.text ?? '',
    }
  }
  if (!isPlainMessage(message) || !message.ts || message.text === undefined) return undefined
  return { channel: message.channel, ts: message.ts, text: message.text }
}

const deletionSchema = z.object({
  type: z.literal('message'),
  subtype: z.literal('message_deleted'),
  channel: z.string(),
  deleted_ts: z.string(),
})

/** The message a `message_deleted` event removed, or `undefined` for other events. */
function slackDeletionOf(event: unknown): { channel: string; ts: string } | undefined {
  const parsed = deletionSchema.safeParse(event)
  return parsed.success ? { channel: parsed.data.channel, ts: parsed.data.deleted_ts } : undefined
}

const unsigned = () => new HTTPException(401, { message: 'invalid Slack signature' })

const freshTimestamp = (timestamp: string | undefined, now: Date) =>
  timestamp !== undefined &&
  /^\d+$/.test(timestamp) &&
  Math.abs(now.getTime() / 1000 - Number(timestamp)) <= SLACK_SIGNATURE_MAX_AGE_SECONDS

/**
 * Slack Events API (`POST /slack/events`, no session: the request is authenticated by its Slack
 * signature over the raw body with the stored signing secret, at most five minutes old). Answers
 * `url_verification` with its challenge; acknowledges events at once and hands message events
 * to the Slack review status in the background (`deps.onBackground`); a deleted message is
 * forgotten. A message event that links a merge request is handled once across processes
 * sharing the store, so Slack's retries are acknowledged and dropped. 401 for missing, bad or
 * stale signature headers (checked before the body is read), 413 for a body over 1 MB, 404
 * while no Slack credential is stored.
 */
export function slackEventRoutes(deps: ServerDeps) {
  const app = new Hono<Env>()
  const slack: SlackReviews = deps.slackReviews ?? createSlackReviews(deps)
  const recent = new Set<string>()

  const firstDelivery = async (eventId: string | undefined) => {
    if (!eventId) return true
    const key = `slack:event:${eventId}`
    const kv = deps.store.kv
    if (kv?.acquireLease) {
      const holder = randomUUID()
      const lease = await kv.acquireLease(key, holder, EVENT_MEMORY_SECONDS, deps.now())
      return lease.holder === holder
    }
    if (recent.has(key)) return false
    recent.add(key)
    if (recent.size > LOCAL_EVENT_MEMORY) recent.delete(recent.values().next().value ?? key)
    return true
  }

  app.post(
    '/slack/events',
    async (c, next) => {
      const timestamp = c.req.header('x-slack-request-timestamp')
      if (!c.req.header('x-slack-signature') || !freshTimestamp(timestamp, deps.now()))
        throw unsigned()
      await next()
    },
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: () => {
        throw new HTTPException(413, { message: 'body too large' })
      },
    }),
    async (c) => {
      const connection = await slackConnection(deps)
      if (!connection) throw new HTTPException(404, { message: 'Slack is not connected' })
      const body = await c.req.text()
      const signed = verifySlackSignature({
        signingSecret: connection.signingSecret,
        timestamp: c.req.header('x-slack-request-timestamp'),
        signature: c.req.header('x-slack-signature'),
        body,
        now: deps.now(),
      })
      if (!signed) throw unsigned()
      let json: unknown
      try {
        json = JSON.parse(body)
      } catch {
        throw new HTTPException(400, { message: 'invalid body' })
      }
      const envelope = envelopeSchema.safeParse(json)
      if (!envelope.success) return c.json({ ok: true })
      if (envelope.data.type === 'url_verification')
        return c.json({ challenge: envelope.data.challenge })
      const deleted = slackDeletionOf(envelope.data.event)
      if (deleted) {
        const forgotten = slack.forgetMessage(deleted.channel, deleted.ts)
        deps.onBackground?.(forgotten)
        return c.json({ ok: true })
      }
      const message = slackMessageOf(envelope.data.event)
      if (!message || newMergeRequestLinks(message, deps.config.forges).length === 0)
        return c.json({ ok: true })
      if (!(await firstDelivery(envelope.data.event_id))) return c.json({ ok: true })
      const handled = slack.handleMessage(message)
      deps.onBackground?.(handled)
      return c.json({ ok: true })
    },
  )

  return app
}
