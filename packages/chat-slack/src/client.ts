import { type Secret, resolveSecret } from '@holtkeeper/forge'
import { z } from 'zod'

import type { SlackBlock, SlackView } from './blocks.ts'

/** The part of `fetch` the client uses; injected so tests never reach Slack. */
export type SlackFetch = (url: string, init: RequestInit) => Promise<Response>

/** A Slack Web API call failed; `code` is Slack's error, e.g. `not_in_channel`, or `http_<status>`. */
export class SlackApiError extends Error {
  readonly code: string

  constructor(method: string, code: string) {
    super(`Slack ${method} failed: ${code}`)
    this.name = 'SlackApiError'
    this.code = code
  }
}

/** A message for `chat.postMessage` and `chat.update`: fallback text and Block Kit blocks. */
export interface SlackMessage {
  text: string
  blocks: SlackBlock[]
}

/** The Slack Web API calls the chat surface needs. */
export interface SlackClient {
  sendMessage(
    input: SlackMessage & { channel: string; threadTs?: string },
  ): Promise<{ channel: string; ts: string }>
  updateMessage(input: SlackMessage & { channel: string; ts: string }): Promise<void>
  openView(triggerId: string, view: SlackView): Promise<void>
  /** The workspace and bot of the token; rejects with `invalid_auth` for a bad token. */
  identity(): Promise<SlackIdentity>
  /** Public channels and the private ones the bot is in, by name; up to 4000. */
  channels(): Promise<SlackChannel[]>
  /** Answers through a slash command's or interaction's `response_url`. */
  respond(
    responseUrl: string,
    message: SlackMessage & { responseType?: 'ephemeral' | 'in_channel' },
  ): Promise<void>
}

/** Who a bot token belongs to (`auth.test`). */
export interface SlackIdentity {
  teamId: string
  team: string
  botUserId: string
  bot: string
  /** The workspace's web address, e.g. `https://acme.slack.com/`. */
  url?: string
}

/** A channel the bot can see (`conversations.list`). */
export interface SlackChannel {
  id: string
  name: string
  private: boolean
  /** The bot was invited, so it can read mentions and post without `chat:write.public`. */
  member: boolean
}

export interface SlackClientOptions {
  /** Bot token (`xoxb-…`), resolved on every call; a function is called on every call too. */
  token: Secret | (() => string | Promise<string>)
  fetch?: SlackFetch
  /** Default `https://slack.com/api`. */
  baseUrl?: string
}

const answerSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  channel: z.string().optional(),
  ts: z.string().optional(),
})

const identitySchema = z.object({
  team_id: z.string(),
  team: z.string(),
  user_id: z.string(),
  user: z.string(),
  url: z.string().optional(),
})

const channelsSchema = z.object({
  channels: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      is_private: z.boolean().optional(),
      is_member: z.boolean().optional(),
    }),
  ),
  response_metadata: z.object({ next_cursor: z.string().optional() }).optional(),
})

const responseUrlHost = /^https:\/\/hooks\.slack\.com\//

/**
 * A Slack Web API client over `fetch`. Calls reject with `SlackApiError` when Slack answers
 * `ok: false` or a non-2xx status; the token never appears in errors.
 */
export function slackClient(options: SlackClientOptions): SlackClient {
  const fetch = options.fetch ?? globalThis.fetch
  const base = (options.baseUrl ?? 'https://slack.com/api').replace(/\/$/, '')

  const token = async () =>
    typeof options.token === 'function' ? options.token() : resolveSecret(options.token)

  const raw = async (method: string, body: Record<string, unknown>): Promise<unknown> => {
    const response = await fetch(`${base}/${method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await token()}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new SlackApiError(method, `http_${response.status}`)
    const json: unknown = await response.json().catch(() => undefined)
    const answer = answerSchema.safeParse(json)
    if (!answer.success) throw new SlackApiError(method, 'invalid_response')
    if (!answer.data.ok) throw new SlackApiError(method, answer.data.error ?? 'unknown_error')
    return json
  }

  const call = async (method: string, body: Record<string, unknown>) =>
    answerSchema.parse(await raw(method, body))

  return {
    async sendMessage({ channel, threadTs, text, blocks }) {
      const answer = await call('chat.postMessage', {
        channel,
        text,
        blocks,
        unfurl_links: false,
        ...(threadTs && { thread_ts: threadTs }),
      })
      if (!answer.ts) throw new SlackApiError('chat.postMessage', 'missing_ts')
      return { channel: answer.channel ?? channel, ts: answer.ts }
    },
    async updateMessage({ channel, ts, text, blocks }) {
      await call('chat.update', { channel, ts, text, blocks })
    },
    async identity() {
      const answer = identitySchema.safeParse(await raw('auth.test', {}))
      if (!answer.success) throw new SlackApiError('auth.test', 'invalid_response')
      const { team_id: teamId, team, user_id: botUserId, user: bot, url } = answer.data
      return { teamId, team, botUserId, bot, ...(url && { url }) }
    },
    async channels() {
      const found: SlackChannel[] = []
      let cursor: string | undefined
      for (let page = 0; page < 20; page++) {
        // oxlint-disable-next-line no-await-in-loop -- cursor pages one after another
        const answer = channelsSchema.safeParse(
          await raw('conversations.list', {
            types: 'public_channel,private_channel',
            exclude_archived: true,
            limit: 200,
            ...(cursor && { cursor }),
          }),
        )
        if (!answer.success) throw new SlackApiError('conversations.list', 'invalid_response')
        for (const channel of answer.data.channels)
          found.push({
            id: channel.id,
            name: channel.name,
            private: channel.is_private ?? false,
            member: channel.is_member ?? false,
          })
        cursor = answer.data.response_metadata?.next_cursor || undefined
        if (!cursor) break
      }
      return found.toSorted((a, b) => a.name.localeCompare(b.name))
    },
    async openView(triggerId, view) {
      await call('views.open', { trigger_id: triggerId, view })
    },
    async respond(responseUrl, { responseType = 'ephemeral', text, blocks }) {
      if (!responseUrlHost.test(responseUrl)) throw new SlackApiError('response_url', 'bad_url')
      const response = await fetch(responseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ response_type: responseType, text, blocks }),
      })
      if (!response.ok) throw new SlackApiError('response_url', `http_${response.status}`)
    },
  }
}
