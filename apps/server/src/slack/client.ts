import { z } from 'zod'

/** What one Slack Web API call answered; `error` is Slack's error code or a transport failure. */
interface SlackResult {
  ok: boolean
  error?: string
}

/** The Slack Web API calls the review status needs: reactions only. Implementations never throw. */
export interface SlackApi {
  /** `reactions.add`; `already_reacted` counts as success. */
  addReaction(input: { channel: string; ts: string; name: string }): Promise<SlackResult>
  /** `reactions.remove`; `no_reaction` counts as success. */
  removeReaction(input: { channel: string; ts: string; name: string }): Promise<SlackResult>
}

/** A message `chat.postMessage` or `chat.update` sends: fallback text and Block Kit blocks. */
export interface SlackMessageBody {
  /** Shown in notifications and where blocks cannot be rendered. */
  text: string
  blocks?: readonly Record<string, unknown>[]
}

/** What posting or updating a message answered; `ts` identifies the message on success. */
interface SlackPostResult extends SlackResult {
  ts?: string
  channel?: string
}

/**
 * The Slack Web API calls that post and edit the bot's messages: release announcements and the
 * status replies of the review status. Implementations never throw.
 */
export interface SlackPoster {
  /**
   * `chat.postMessage` as the bot, in the thread of `threadTs` when given; needs the
   * `chat:write` scope.
   */
  post(input: { channel: string; threadTs?: string } & SlackMessageBody): Promise<SlackPostResult>
  /** `chat.update` of a message the bot posted. */
  update(input: { channel: string; ts: string } & SlackMessageBody): Promise<SlackPostResult>
}

/** Options of `slackWebApi` and `slackWebPoster`. */
export interface SlackWebApiOptions {
  token: string
  /** Default: global `fetch`. */
  fetch?: typeof fetch
  /** Default: `https://slack.com/api`. */
  baseUrl?: string
  /** Rate-limited calls are retried this often, after Slack's `Retry-After`. Default 3. */
  retries?: number
  /** A `Retry-After` longer than this gives up instead of waiting. Default 30 s. */
  maxWaitMs?: number
  /**
   * Rate-limit waits of all calls through this client together stay under this; a wait that
   * would exceed it gives up instead. Default 30 s.
   */
  budgetMs?: number
  /** Each request is aborted after this long. Default 10 s. */
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
  log?: (line: string) => void
}

const answerSchema = z
  .object({
    ok: z.boolean().optional().catch(undefined),
    error: z.string().optional().catch(undefined),
    ts: z.string().optional().catch(undefined),
    channel: z.string().optional().catch(undefined),
  })
  .catch({})

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** One Web API method call with retries on 429; never throws. */
function slackCaller(options: SlackWebApiOptions) {
  const fetchFn = options.fetch ?? fetch
  const baseUrl = options.baseUrl ?? 'https://slack.com/api'
  const retries = options.retries ?? 3
  const maxWaitMs = options.maxWaitMs ?? 30_000
  const timeoutMs = options.timeoutMs ?? 10_000
  let budgetMs = options.budgetMs ?? 30_000
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms))
  const log = options.log ?? ((line: string) => console.error(line))

  const call = async (
    method: string,
    body: Record<string, unknown>,
    harmless: readonly string[] = [],
  ): Promise<SlackPostResult> => {
    for (let attempt = 0; ; attempt++) {
      let response: Response
      try {
        // oxlint-disable-next-line no-await-in-loop -- retries wait for the previous answer
        response = await fetchFn(`${baseUrl}/${method}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.token}`,
            'content-type': 'application/json; charset=utf-8',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (error) {
        log(`slack ${method}: ${messageOf(error)}`)
        return { ok: false, error: messageOf(error) }
      }
      if (response.status === 429) {
        const waitMs = Number(response.headers.get('retry-after') ?? '1') * 1000
        if (
          attempt >= retries ||
          !Number.isFinite(waitMs) ||
          waitMs > maxWaitMs ||
          waitMs > budgetMs
        ) {
          log(`slack ${method}: rate limited`)
          return { ok: false, error: 'ratelimited' }
        }
        budgetMs -= Math.max(waitMs, 0)
        // oxlint-disable-next-line no-await-in-loop -- see above
        await sleep(Math.max(waitMs, 0))
        continue
      }
      // oxlint-disable-next-line no-await-in-loop -- see above
      const answer = answerSchema.parse(await response.json().catch(() => undefined))
      if (answer.ok === true)
        return {
          ok: true,
          ...(answer.ts !== undefined && { ts: answer.ts }),
          ...(answer.channel !== undefined && { channel: answer.channel }),
        }
      const error = answer.error ?? `HTTP ${response.status}`
      if (harmless.includes(error)) return { ok: true }
      log(`slack ${method}: ${error}`)
      return { ok: false, error }
    }
  }

  return call
}

const resultOf = async (pending: Promise<SlackPostResult>): Promise<SlackResult> => {
  const { ok, error } = await pending
  return error === undefined ? { ok } : { ok, error }
}

/**
 * A `SlackApi` over `fetch` with a bot token. A 429 is retried after its `Retry-After`, within
 * the client's wait budget; failures
 * (HTTP, network, Slack errors other than the harmless ones) are logged and answered as
 * `{ ok: false, error }`, never thrown.
 */
export function slackWebApi(options: SlackWebApiOptions): SlackApi {
  const call = slackCaller(options)
  return {
    addReaction: ({ channel, ts, name }) =>
      resultOf(call('reactions.add', { channel, timestamp: ts, name }, ['already_reacted'])),
    removeReaction: ({ channel, ts, name }) =>
      resultOf(call('reactions.remove', { channel, timestamp: ts, name }, ['no_reaction'])),
  }
}

const messageBody = (message: SlackMessageBody) => ({
  text: message.text,
  ...(message.blocks && { blocks: message.blocks }),
})

/**
 * A `SlackPoster` over `fetch` with a bot token, with the retries, wait budget and logging of
 * `slackWebApi`. Link and media previews are off, so a message with many links stays compact.
 */
export function slackWebPoster(options: SlackWebApiOptions): SlackPoster {
  const call = slackCaller(options)
  return {
    post: ({ channel, threadTs, ...message }) =>
      call('chat.postMessage', {
        channel,
        ...(threadTs !== undefined && { thread_ts: threadTs }),
        ...messageBody(message),
        unfurl_links: false,
        unfurl_media: false,
      }),
    update: ({ channel, ts, ...message }) =>
      call('chat.update', { channel, ts, ...messageBody(message) }),
  }
}
