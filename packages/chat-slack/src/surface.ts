import type { ChatSurface, ChatThread, PostedMessage } from '@holtkeeper/chat'

import { renderSlackMessage } from './blocks.ts'
import { SlackApiError, type SlackClient } from './client.ts'

/** A Slack conversation: a channel, optionally a thread in it, and a slash command's `response_url`. */
export interface SlackThread {
  channel: string
  threadTs?: string
  responseUrl?: string
}

const threadOf = (thread: ChatThread): SlackThread => {
  const { channel, threadTs, responseUrl } = thread
  if (typeof channel !== 'string') throw new Error('not a Slack thread')
  return {
    channel,
    ...(typeof threadTs === 'string' && { threadTs }),
    ...(typeof responseUrl === 'string' && { responseUrl }),
  }
}

/** Errors meaning the bot cannot post into the channel, e.g. it was not invited. */
const unreachable = new Set(['not_in_channel', 'channel_not_found', 'is_archived'])

export interface SlackSurfaceOptions {
  client: SlackClient
  /** Default `slack`. */
  id?: string
  prefix?: string
}

/**
 * Slack as a chat surface. Cards become Block Kit messages (`renderSlackMessage`) in the channel,
 * in the thread when there is one, and updates edit them in place (`chat.update`). Where the bot
 * may not post (not invited to the channel) and the message came from a slash command, the card
 * is answered privately through `response_url` instead; such answers cannot be updated.
 */
export function slackSurface(options: SlackSurfaceOptions): ChatSurface {
  const id = options.id ?? 'slack'
  const render = (card: Parameters<typeof renderSlackMessage>[0]) =>
    renderSlackMessage(card, options.prefix ? { prefix: options.prefix } : {})

  return {
    id,
    async post(raw, card): Promise<PostedMessage> {
      const thread = threadOf(raw)
      const message = render(card)
      try {
        const posted = await options.client.sendMessage({
          channel: thread.channel,
          ...(thread.threadTs && { threadTs: thread.threadTs }),
          ...message,
        })
        return { surface: id, thread: raw, id: `${posted.channel}/${posted.ts}` }
      } catch (error) {
        if (
          !(error instanceof SlackApiError) ||
          !unreachable.has(error.code) ||
          !thread.responseUrl
        )
          throw error
        await options.client.respond(thread.responseUrl, message)
        return { surface: id, thread: raw }
      }
    },
    async update(posted, card) {
      const [channel, ts] = (posted.id ?? '').split('/')
      if (!channel || !ts) throw new Error('not a Slack message')
      await options.client.updateMessage({ channel, ts, ...render(card) })
    },
  }
}
