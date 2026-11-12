import type { Card, ChatSurface, PostedMessage } from '@holtkeeper/chat'
import type { ChatMessageRef, ChatStore } from '@holtkeeper/store'

import { uniqueRefs } from './chat-prompt.ts'

const threadOf = (thread: Record<string, string | number>) => {
  const { thread: id } = thread
  if (typeof id !== 'string') throw new Error('not a panel thread')
  return id
}

/**
 * What a card posted to a panel thread refers to: the repository the command ran about (the
 * address's `repo`), then the task groups and repositories of its task blocks.
 */
function cardRefs(card: Card, address: Record<string, string | number>): ChatMessageRef[] {
  const repo = typeof address['repo'] === 'string' ? address['repo'] : undefined
  return uniqueRefs([
    ...(repo ? [{ kind: 'repo' as const, repo }] : []),
    ...card.blocks.flatMap((block): ChatMessageRef[] =>
      block.type === 'task'
        ? [
            ...(block.groupId ? [{ kind: 'task' as const, id: block.groupId }] : []),
            ...block.repos.map((each) => ({ kind: 'repo' as const, repo: each })),
          ]
        : [],
    ),
  ])
}

/**
 * The panel as a chat surface: the address is `{ thread, repo? }` (a team chat thread id and the
 * repository a command ran about), posting adds a system message with the card and its refs
 * (`cardRefs`) to that thread and updating replaces the card in place, which the page picks up on
 * its next poll.
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
        refs: cardRefs(card, thread),
        createdAt: now().toISOString(),
      })
      return { surface: 'web', thread, id: message.id }
    },
    async update(posted, card) {
      if (posted.id === undefined) throw new Error('not a panel message')
      threadOf(posted.thread)
      await chat.updateMessage(posted.id, {
        card,
        refs: cardRefs(card, posted.thread),
        updatedAt: now().toISOString(),
      })
    },
  }
}
