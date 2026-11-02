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
  /** Answers through a slash command's or interaction's `response_url`. */
  respond(
    responseUrl: string,
    message: SlackMessage & { responseType?: 'ephemeral' | 'in_channel' },
  ): Promise<void>
}

export interface SlackClientOptions {
  /** Bot token (`xoxb-…`), resolved on every call. */
  token: Secret
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

const responseUrlHost = /^https:\/\/hooks\.slack\.com\//

/**
 * A Slack Web API client over `fetch`. Calls reject with `SlackApiError` when Slack answers
 * `ok: false` or a non-2xx status; the token never appears in errors.
 */
export function slackClient(options: SlackClientOptions): SlackClient {
  const fetch = options.fetch ?? globalThis.fetch
  const base = (options.baseUrl ?? 'https://slack.com/api').replace(/\/$/, '')

  const call = async (method: string, body: Record<string, unknown>) => {
    const response = await fetch(`${base}/${method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${resolveSecret(options.token)}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new SlackApiError(method, `http_${response.status}`)
    const answer = answerSchema.safeParse(await response.json().catch(() => undefined))
    if (!answer.success) throw new SlackApiError(method, 'invalid_response')
    if (!answer.data.ok) throw new SlackApiError(method, answer.data.error ?? 'unknown_error')
    return answer.data
  }

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
