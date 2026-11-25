import { randomUUID } from 'node:crypto'

import { COMMAND_ACTION } from '@holtkeeper/chat-slack'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import type { Env, ServerDeps } from '../context.ts'
import { slackWebPoster } from '../slack/client.ts'
import { type SlackCompareBot, createSlackCompareBot } from '../slack/compare-bot.ts'
import { COMPARE_CANCEL, COMPARE_CONFIRM } from '../slack/compare-messages.ts'
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
    authorizations: z
      .array(z.object({ user_id: z.string().optional(), is_bot: z.boolean().optional() }))
      .optional()
      .catch(undefined),
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

const personMessageSchema = z.object({
  type: z.literal('message'),
  subtype: z.string().optional(),
  channel: z.string(),
  channel_type: z.string().optional(),
  user: z.string(),
  text: z.string(),
  ts: z.string(),
  thread_ts: z.string().optional(),
  bot_id: z.string().optional(),
})

/**
 * A person's message in a channel the app is in, which the comparison bot reads when it mentions
 * the app: plain messages, thread replies, thread broadcasts and file shares; bot messages, edits and direct messages are left out.
 */
function slackPersonMessageOf(event: unknown) {
  const parsed = personMessageSchema.safeParse(event)
  if (!parsed.success) return undefined
  const message = parsed.data
  if (!handledChannelTypes.has(message.channel_type) || !isPlainMessage(message)) return undefined
  const threadTs = message.thread_ts !== message.ts ? message.thread_ts : undefined
  return {
    channel: message.channel,
    user: message.user,
    text: message.text,
    ts: message.ts,
    ...(threadTs !== undefined && { threadTs }),
  }
}

const interactionSchema = z.object({
  type: z.literal('block_actions'),
  user: z.object({ id: z.string() }),
  channel: z.object({ id: z.string() }),
  message: z.object({ ts: z.string(), thread_ts: z.string().optional() }),
  actions: z.array(z.object({ action_id: z.string(), value: z.string().optional() })).min(1),
})

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

const signatureHeaders = async (
  c: { req: { header(name: string): string | undefined } },
  next: () => Promise<void>,
  deps: ServerDeps,
) => {
  const timestamp = c.req.header('x-slack-request-timestamp')
  if (!c.req.header('x-slack-signature') || !freshTimestamp(timestamp, deps.now())) throw unsigned()
  await next()
}

const limitBody = bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: () => {
    throw new HTTPException(413, { message: 'body too large' })
  },
})

/** The raw body once its Slack signature checks out; 404 without a credential, 401 when it does not. */
async function signedBody(
  c: { req: { header(name: string): string | undefined; text(): Promise<string> } },
  deps: ServerDeps,
): Promise<string> {
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
  return body
}

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
  let comparisons: SlackCompareBot | undefined = deps.slackCompare
  const compare = () => (comparisons ??= createSlackCompareBot(deps))
  const background = (work: Promise<unknown>) => {
    if (deps.onBackground) deps.onBackground(work)
    else void work
  }
  const recent = new Set<string>()
  const botUsers = new Map<string, Promise<string | undefined>>()

  /**
   * The app's own user id: from the delivery's `authorizations`, else `auth.test` once per bot
   * token and process.
   */
  const botUserId = async (
    authorizations: { user_id?: string | undefined; is_bot?: boolean | undefined }[] | undefined,
  ) => {
    const listed = authorizations?.find((entry) => entry.is_bot && entry.user_id)?.user_id
    if (listed) return listed
    const connection = await slackConnection(deps)
    if (!connection) return undefined
    let pending = botUsers.get(connection.botToken)
    if (!pending) {
      const poster = (deps.slackPoster ?? ((token) => slackWebPoster({ token })))(
        connection.botToken,
      )
      pending = poster.botUserId?.() ?? Promise.resolve(undefined)
      botUsers.set(connection.botToken, pending)
    }
    const id = await pending
    if (!id) botUsers.delete(connection.botToken)
    return id
  }

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
    (c, next) => signatureHeaders(c, next, deps),
    limitBody,
    async (c) => {
      const body = await signedBody(c, deps)
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
      const event = envelope.data.event
      const deleted = slackDeletionOf(event)
      if (deleted) {
        const forgotten = slack.forgetMessage(deleted.channel, deleted.ts)
        deps.onBackground?.(forgotten)
        return c.json({ ok: true })
      }
      const person = slackPersonMessageOf(event)
      const message = slackMessageOf(event)
      const linked =
        message !== undefined && newMergeRequestLinks(message, deps.config.forges).length > 0
      const bot =
        person?.text.includes('<@') === true
          ? await botUserId(envelope.data.authorizations)
          : undefined
      const mentioned =
        person !== undefined && bot !== undefined && person.text.includes(`<@${bot}>`)
      if (!mentioned && !linked) return c.json({ ok: true })
      if (!(await firstDelivery(envelope.data.event_id))) return c.json({ ok: true })
      if (person && mentioned) background(compare().handleMention(person))
      if (message && linked) background(slack.handleMessage(message))
      return c.json({ ok: true })
    },
  )

  app.post(
    '/slack/interactions',
    (c, next) => signatureHeaders(c, next, deps),
    limitBody,
    async (c) => {
      const body = await signedBody(c, deps)
      let json: unknown
      try {
        json = JSON.parse(new URLSearchParams(body).get('payload') ?? '')
      } catch {
        throw new HTTPException(400, { message: 'invalid body' })
      }
      const payload = interactionSchema.safeParse(json)
      if (!payload.success) return c.body(null, 200)
      const { user, channel, message, actions } = payload.data
      const action = actions.find((entry) => entry.action_id.startsWith(COMMAND_ACTION))
      const kind =
        action?.value === COMPARE_CONFIRM
          ? 'confirm'
          : action?.value === COMPARE_CANCEL
            ? 'cancel'
            : undefined
      if (kind)
        background(
          compare().handleAction({
            channel: channel.id,
            threadTs: message.thread_ts ?? message.ts,
            user: user.id,
            action: kind,
          }),
        )
      return c.body(null, 200)
    },
  )

  return app
}
