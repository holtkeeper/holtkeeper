import type { Database } from 'bun:sqlite'

import type { ChatMessage, ChatStore, ChatThread, ChatThreadRead } from '@holtkeeper/store'
import { byChatThreadUpdate, chatPageSize, newChatThread, patchChatThread } from '@holtkeeper/store'

interface ThreadRow {
  data: string
}

interface MessageRow {
  seq: number
  data: string
}

interface ReadRow {
  thread_id: string
  user_id: string
  last_read_message_id: string
  last_read_seq: number
}

const toThread = (row: ThreadRow): ChatThread => JSON.parse(row.data)
const toMessage = (row: MessageRow): ChatMessage => ({ ...JSON.parse(row.data), seq: row.seq })
const toRead = (row: ReadRow): ChatThreadRead => ({
  threadId: row.thread_id,
  userId: row.user_id,
  lastReadMessageId: row.last_read_message_id,
  lastReadSeq: row.last_read_seq,
})

const dataOf = (message: ChatMessage) => {
  const { seq: _seq, ...rest } = message
  return JSON.stringify(rest)
}

/**
 * The SQLite `ChatStore`: threads as JSON rows in `chat_threads`, messages in `chat_messages`
 * (their `seq` is the autoincrement key), read markers in `chat_thread_reads`.
 */
export function sqliteChat(db: Database): ChatStore {
  const sql = {
    threadGet: db.query<ThreadRow, [string]>('SELECT data FROM chat_threads WHERE id = ?'),
    threadList: db.query<ThreadRow, [number]>(
      'SELECT data FROM chat_threads WHERE archived = ? ORDER BY updated_at DESC, id',
    ),
    threadPut: db.prepare(
      `INSERT INTO chat_threads (id, updated_at, archived, data) VALUES (?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         updated_at = excluded.updated_at, archived = excluded.archived, data = excluded.data`,
    ),
    messageAdd: db.query<{ seq: number }, [string, string, string | null, string, string]>(
      `INSERT INTO chat_messages (id, thread_id, author_id, created_at, data)
       VALUES (?, ?, ?, ?, ?) RETURNING seq`,
    ),
    messageGet: db.query<MessageRow, [string]>('SELECT seq, data FROM chat_messages WHERE id = ?'),
    messageUpdate: db.prepare('UPDATE chat_messages SET updated_at = ?, data = ? WHERE id = ?'),
    after: db.query<MessageRow, [string, number, number]>(
      'SELECT seq, data FROM chat_messages WHERE thread_id = ? AND seq > ? ORDER BY seq LIMIT ?',
    ),
    before: db.query<MessageRow, [string, number, number]>(
      `SELECT seq, data FROM (
         SELECT seq, data FROM chat_messages WHERE thread_id = ? AND seq < ?
         ORDER BY seq DESC LIMIT ?
       ) ORDER BY seq`,
    ),
    changed: db.query<MessageRow, [string, string]>(
      `SELECT seq, data FROM chat_messages
       WHERE thread_id = ? AND updated_at IS NOT NULL AND updated_at >= ? ORDER BY seq`,
    ),
    readPut: db.prepare(
      `INSERT INTO chat_thread_reads (thread_id, user_id, last_read_message_id, last_read_seq)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (thread_id, user_id) DO UPDATE SET
         last_read_message_id = excluded.last_read_message_id,
         last_read_seq = excluded.last_read_seq
       WHERE excluded.last_read_seq > chat_thread_reads.last_read_seq`,
    ),
    readsOf: db.query<ReadRow, [string]>(
      'SELECT * FROM chat_thread_reads WHERE user_id = ? ORDER BY thread_id',
    ),
    unread: db.query<{ count: number }, [string, string, string, string]>(
      `SELECT count(*) AS count FROM chat_messages m
       WHERE m.thread_id = ?
         AND m.seq > coalesce(
           (SELECT last_read_seq FROM chat_thread_reads WHERE thread_id = ? AND user_id = ?), 0)
         AND (m.author_id IS NULL OR m.author_id <> ?)`,
    ),
  }

  const put = (thread: ChatThread) =>
    sql.threadPut.run(thread.id, thread.updatedAt, thread.archived ? 1 : 0, JSON.stringify(thread))
  const readThread = (id: string) => {
    const row = sql.threadGet.get(id)
    return row ? toThread(row) : undefined
  }
  const readMessage = (id: string) => {
    const row = sql.messageGet.get(id)
    return row ? toMessage(row) : undefined
  }

  const update = db.transaction((id: string, patch: Parameters<ChatStore['updateThread']>[1]) => {
    const thread = readThread(id)
    if (!thread) return undefined
    const next = patchChatThread(thread, patch)
    put(next)
    return next
  })
  const add = db.transaction((input: Parameters<ChatStore['addMessage']>[0]): ChatMessage => {
    const row = sql.messageAdd.get(
      input.id,
      input.threadId,
      input.authorId ?? null,
      input.createdAt,
      JSON.stringify(input),
    )
    if (!row) throw new Error('chat: the message was not stored')
    const thread = readThread(input.threadId)
    if (thread && thread.updatedAt < input.createdAt) put({ ...thread, updatedAt: input.createdAt })
    return { ...input, seq: row.seq }
  })
  const change = db.transaction(
    (id: string, patch: Parameters<ChatStore['updateMessage']>[1]): ChatMessage | undefined => {
      const message = readMessage(id)
      if (!message) return undefined
      const next: ChatMessage = {
        ...message,
        ...(patch.card !== undefined && { card: patch.card }),
        ...(patch.body !== undefined && { body: patch.body }),
        updatedAt: patch.updatedAt,
      }
      sql.messageUpdate.run(patch.updatedAt, dataOf(next), id)
      return next
    },
  )

  return {
    async createThread(input) {
      const thread = newChatThread(input)
      put(thread)
      return thread
    },
    getThread: async (id) => readThread(id),
    listThreads: async (filter = {}) =>
      sql.threadList
        .all(filter.archived ? 1 : 0)
        .map(toThread)
        .toSorted(byChatThreadUpdate),
    updateThread: async (id, patch) => update.immediate(id, patch),
    addMessage: async (input) => add.immediate(input),
    getMessage: async (id) => readMessage(id),
    updateMessage: async (id, patch) => change.immediate(id, patch),
    async listMessages(threadId, query = {}) {
      const size = chatPageSize(query)
      const page = (
        query.after !== undefined
          ? sql.after.all(threadId, query.after, size)
          : sql.before.all(threadId, query.before ?? Number.MAX_SAFE_INTEGER, size)
      ).map(toMessage)
      if (query.changedSince === undefined) return page
      const seen = new Set(page.map((message) => message.id))
      const changed = sql.changed
        .all(threadId, query.changedSince)
        .map(toMessage)
        .filter((message) => !seen.has(message.id))
      return [...page, ...changed].toSorted((a, b) => a.seq - b.seq)
    },
    async markRead(threadId, userId, messageId) {
      const message = readMessage(messageId)
      if (!message || message.threadId !== threadId) return
      sql.readPut.run(threadId, userId, messageId, message.seq)
    },
    reads: async (userId) => sql.readsOf.all(userId).map(toRead),
    async unreadCounts(userId, threadIds) {
      const counts: Record<string, number> = {}
      for (const threadId of threadIds) {
        const count = sql.unread.get(threadId, threadId, userId, userId)?.count ?? 0
        if (count > 0) counts[threadId] = count
      }
      return counts
    },
  }
}
