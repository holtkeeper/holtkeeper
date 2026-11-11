import type { ChatSurface, PostedMessage } from '@holtkeeper/chat'
import type { ChatStore } from '@holtkeeper/store'

const threadOf = (thread: Record<string, string | number>) => {
  const { thread: id } = thread
  if (typeof id !== 'string') throw new Error('not a panel thread')
  return id
}

/**
 * The panel as a chat surface: the address is `{ thread }` (a team chat thread id), posting adds a
 * system message with the card to that thread and updating replaces the card in place, which the
 * page picks up on its next poll.
 */
export function webSurface(chat: ChatStore, now: () => Date): ChatSurface {
  return {
    id: 'web',
    async post(thread, card): Promise<PostedMessage> {
      const message = await chat.addMessage({
        id: crypto.randomUUID(),
        threadId: threadOf(thread),
        authorType: 'system',
        body: '',
        card,
        mentions: [],
        createdAt: now().toISOString(),
      })
      return { surface: 'web', thread, id: message.id }
    },
    async update(posted, card) {
      if (posted.id === undefined) throw new Error('not a panel message')
      threadOf(posted.thread)
      await chat.updateMessage(posted.id, { card, updatedAt: now().toISOString() })
    },
  }
}
