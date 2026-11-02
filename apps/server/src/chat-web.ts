import type { ChatMessageView } from '@holtkeeper/api'
import type { Card, ChatSurface, PostedMessage } from '@holtkeeper/chat'
import type { KvStore } from '@holtkeeper/store'
import { z } from 'zod'

/** Messages kept per person; older ones drop off. */
const KEEP = 100
const TTL_SECONDS = 30 * 86_400
/** Attempts of a compare-and-set write before giving up on a busy conversation. */
const ATTEMPTS = 5

const keyOf = (userId: string) => `chat:web:${userId}`

const messagesSchema = z.array(
  z
    .object({
      id: z.string(),
      from: z.enum(['user', 'holtkeeper']),
      at: z.string(),
      updatedAt: z.string().optional(),
      text: z.string().optional(),
      card: z.custom<Card>((value) => typeof value === 'object' && value !== null),
      repo: z.string().optional(),
    })
    .partial({ card: true }),
)

/** The panel conversations, one per person, in `store.kv`. */
export interface WebChatStore {
  list(userId: string): Promise<ChatMessageView[]>
  append(userId: string, message: Omit<ChatMessageView, 'id' | 'at'>): Promise<ChatMessageView>
  /** Replaces the card of a message; `false` when the message is gone. */
  replace(userId: string, id: string, card: Card): Promise<boolean>
  clear(userId: string): Promise<void>
}

/**
 * Conversations as one `store.kv` value per person (`chat:web:<user id>`, the last 100 messages,
 * kept 30 days after the last change). With `compareAndSet` concurrent writes (a command answering
 * while a deploy card updates) retry instead of losing one another.
 */
export function webChatStore(
  kv: Pick<KvStore, 'get' | 'set' | 'delete' | 'compareAndSet'>,
  now: () => Date,
): WebChatStore {
  const read = async (userId: string) => {
    const raw = await kv.get(keyOf(userId))
    const parsed = messagesSchema.safeParse(raw)
    return { raw, messages: parsed.success ? (parsed.data as ChatMessageView[]) : [] }
  }

  const change = async (
    userId: string,
    edit: (messages: ChatMessageView[]) => ChatMessageView[] | undefined,
  ) => {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      // oxlint-disable-next-line no-await-in-loop -- retries of one compare-and-set
      const { raw, messages } = await read(userId)
      const next = edit(messages)
      if (!next) return false
      const value = next.slice(-KEEP)
      if (!kv.compareAndSet) {
        // oxlint-disable-next-line no-await-in-loop -- single attempt without compare-and-set
        await kv.set(keyOf(userId), value, TTL_SECONDS)
        return true
      }
      // oxlint-disable-next-line no-await-in-loop -- retries of one compare-and-set
      if (await kv.compareAndSet(keyOf(userId), raw, value, TTL_SECONDS)) return true
    }
    throw new Error('the conversation changed too often to save a message')
  }

  return {
    list: async (userId) => (await read(userId)).messages,
    async append(userId, message) {
      const stored: ChatMessageView = {
        ...message,
        id: crypto.randomUUID(),
        at: now().toISOString(),
      }
      await change(userId, (messages) => [...messages, stored])
      return stored
    },
    replace: (userId, id, card) =>
      change(userId, (messages) =>
        messages.some((message) => message.id === id)
          ? messages.map((message) =>
              message.id === id ? { ...message, card, updatedAt: now().toISOString() } : message,
            )
          : undefined,
      ),
    clear: (userId) => kv.delete(keyOf(userId)),
  }
}

const userOf = (thread: Record<string, string | number>) => {
  const { user } = thread
  if (typeof user !== 'string') throw new Error('not a panel conversation')
  return user
}
/**
 * The panel as a chat surface: the thread is `{ user }`, posting appends a Holtkeeper message to
 * that person's conversation and updating replaces its card, which the page shows on its next poll.
 */
export function webSurface(store: WebChatStore): ChatSurface {
  return {
    id: 'web',
    async post(thread, card): Promise<PostedMessage> {
      const message = await store.append(userOf(thread), {
        from: 'holtkeeper',
        card,
        ...(typeof thread['repo'] === 'string' && { repo: thread['repo'] }),
      })
      return { surface: 'web', thread, id: message.id }
    },
    async update(posted, card) {
      if (posted.id === undefined) throw new Error('not a panel message')
      await store.replace(userOf(posted.thread), posted.id, card)
    },
  }
}
