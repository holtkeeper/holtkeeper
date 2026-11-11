import type {
  ChatMessage,
  ChatMessageQuery,
  ChatStore,
  ChatThread,
  ChatThreadInput,
  ChatThreadPatch,
  ChatThreadRead,
} from './types.ts'

const clone = <T>(value: T): T => structuredClone(value)

/** Default and largest page of `ChatStore.listMessages`. */
export const CHAT_PAGE = { default: 50, max: 500 } as const

/** `query.limit` clamped to `CHAT_PAGE`. */
export const chatPageSize = (query: ChatMessageQuery = {}) =>
  Math.min(Math.max(Math.trunc(query.limit ?? CHAT_PAGE.default), 1), CHAT_PAGE.max)

/** The stored thread `ChatStore.createThread` makes of `input`. */
export const newChatThread = (input: ChatThreadInput): ChatThread => ({
  ...input,
  updatedAt: input.createdAt,
  archived: false,
  participants: input.participants ?? [],
})

/** `thread` with `patch` applied; `null` fields are removed (see `ChatThreadPatch`). */
export function patchChatThread(thread: ChatThread, patch: ChatThreadPatch): ChatThread {
  const next: ChatThread = { ...thread }
  if (patch.title !== undefined) next.title = patch.title
  if (patch.archived !== undefined) next.archived = patch.archived
  if (patch.autoReply !== undefined) next.autoReply = patch.autoReply
  if (patch.participants !== undefined) next.participants = patch.participants
  if (patch.addParticipants !== undefined)
    next.participants = [
      ...next.participants,
      ...new Set(patch.addParticipants.filter((id) => !next.participants.includes(id))),
    ]
  if (patch.rememberPeople !== undefined) {
    const ids = new Set(patch.rememberPeople.map((person) => person.id))
    next.people = [
      ...(next.people ?? []).filter((person) => !ids.has(person.id)),
      ...patch.rememberPeople,
    ]
  }
  if (patch.summary === null) delete next.summary
  else if (patch.summary !== undefined) next.summary = patch.summary
  if (patch.releaseReply !== undefined && next.replyingBy === patch.releaseReply) {
    delete next.replyingSince
    delete next.replyingBy
  }
  const claim = patch.claimReply
  if (claim && (next.replyingSince === undefined || next.replyingSince < claim.staleBefore)) {
    next.replyingSince = claim.at
    next.replyingBy = claim.by
  }
  return next
}

/** Newest `updatedAt` first, then id, as `listThreads` orders. */
export const byChatThreadUpdate = (a: ChatThread, b: ChatThread) =>
  a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id < b.id ? -1 : 1

/**
 * The page of `messages` (one thread, ascending `seq`) that `query` selects, oldest first:
 * `after` takes the oldest after it, otherwise the newest (before `before` when given);
 * `changedSince` adds messages changed in place since then.
 */
export function selectChatMessages(
  messages: readonly ChatMessage[],
  query: ChatMessageQuery = {},
): ChatMessage[] {
  const size = chatPageSize(query)
  let page: ChatMessage[]
  if (query.after !== undefined) {
    const after = query.after
    page = messages.filter((message) => message.seq > after).slice(0, size)
  } else {
    const before = query.before
    page = messages.filter((message) => before === undefined || message.seq < before).slice(-size)
  }
  if (query.changedSince === undefined) return page
  const since = query.changedSince
  const seen = new Set(page.map((message) => message.id))
  const changed = messages.filter(
    (message) =>
      !seen.has(message.id) && message.updatedAt !== undefined && message.updatedAt >= since,
  )
  return [...page, ...changed].toSorted((a, b) => a.seq - b.seq)
}

const readKey = (threadId: string, userId: string) => `${threadId}\u0000${userId}`

/** The in-memory `ChatStore`. */
export function memoryChat(): ChatStore {
  const threads = new Map<string, ChatThread>()
  const messages = new Map<string, ChatMessage>()
  const reads = new Map<string, ChatThreadRead>()
  let seq = 0

  const ofThread = (threadId: string) =>
    [...messages.values()]
      .filter((message) => message.threadId === threadId)
      .toSorted((a, b) => a.seq - b.seq)

  return {
    async createThread(input) {
      const thread = newChatThread(clone(input))
      threads.set(thread.id, thread)
      return clone(thread)
    },
    getThread: async (id) => clone(threads.get(id)),
    listThreads: async (filter = {}) =>
      [...threads.values()]
        .filter((thread) => thread.archived === (filter.archived ?? false))
        .toSorted(byChatThreadUpdate)
        .map(clone),
    async updateThread(id, patch) {
      const thread = threads.get(id)
      if (!thread) return undefined
      const next = patchChatThread(thread, clone(patch))
      threads.set(id, next)
      return clone(next)
    },
    async addMessage(input) {
      seq += 1
      const message: ChatMessage = { ...clone(input), seq }
      messages.set(message.id, message)
      const thread = threads.get(message.threadId)
      if (thread && thread.updatedAt < message.createdAt) thread.updatedAt = message.createdAt
      return clone(message)
    },
    getMessage: async (id) => clone(messages.get(id)),
    async updateMessage(id, patch) {
      const message = messages.get(id)
      if (!message) return undefined
      if (patch.card !== undefined) message.card = clone(patch.card)
      if (patch.body !== undefined) message.body = patch.body
      message.updatedAt = patch.updatedAt
      return clone(message)
    },
    listMessages: async (threadId, query) =>
      selectChatMessages(ofThread(threadId), query).map(clone),
    async markRead(threadId, userId, messageId) {
      const message = messages.get(messageId)
      if (!message || message.threadId !== threadId) return
      const key = readKey(threadId, userId)
      const current = reads.get(key)
      if (current && current.lastReadSeq >= message.seq) return
      reads.set(key, { threadId, userId, lastReadMessageId: messageId, lastReadSeq: message.seq })
    },
    reads: async (userId) =>
      [...reads.values()].filter((read) => read.userId === userId).map(clone),
    async unreadCounts(userId, threadIds) {
      const counts: Record<string, number> = {}
      for (const threadId of threadIds) {
        const from = reads.get(readKey(threadId, userId))?.lastReadSeq ?? 0
        const count = ofThread(threadId).filter(
          (message) => message.seq > from && message.authorId !== userId,
        ).length
        if (count > 0) counts[threadId] = count
      }
      return counts
    },
  }
}
