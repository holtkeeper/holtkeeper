import type { ChatMessage, ChatStore, ChatThread, ChatThreadRead } from '@holtkeeper/store'
import { chatPageSize, newChatThread, patchChatThread } from '@holtkeeper/store'

import type { Db } from './tables.ts'

interface MessageRow {
  seq: number
  data: Omit<ChatMessage, 'seq'>
}

const toMessage = (row: MessageRow): ChatMessage => ({ ...row.data, seq: row.seq })

const dataOf = (message: ChatMessage) => {
  const { seq: _seq, ...rest } = message
  return rest
}

/**
 * The SQL `ChatStore`: threads as JSON rows in `chat_threads`, messages in `chat_messages`
 * (their `seq` is an identity column), read markers in `chat_thread_reads`. Read-modify-write
 * changes lock the row they change; a new message locks its thread first, so the messages of
 * one thread commit in `seq` order and an `after` cursor never skips one.
 */
export function postgresChat(db: () => Promise<Db>): ChatStore {
  const getThread = async (id: string) => {
    const { sql, t } = await db()
    const [row]: { data: ChatThread }[] = await sql`
      SELECT data FROM ${t.chatThreads} WHERE id = ${id}`
    return row?.data
  }
  const getMessage = async (id: string) => {
    const { sql, t } = await db()
    const [row]: MessageRow[] = await sql`
      SELECT seq, data FROM ${t.chatMessages} WHERE id = ${id}`
    return row ? toMessage(row) : undefined
  }

  return {
    async createThread(input) {
      const { sql, t } = await db()
      const thread = newChatThread(input)
      await sql`
        INSERT INTO ${t.chatThreads} (id, updated_at, archived, data)
        VALUES (${thread.id}, ${thread.updatedAt}, ${thread.archived}, ${sql.json(thread)})`
      return thread
    },
    getThread,
    async listThreads(filter = {}) {
      const { sql, t } = await db()
      const rows: { data: ChatThread }[] = await sql`
        SELECT data FROM ${t.chatThreads} WHERE archived = ${filter.archived ?? false}
        ORDER BY updated_at COLLATE "C" DESC, id COLLATE "C"`
      return rows.map((row) => row.data)
    },
    async updateThread(id, patch) {
      const { sql, t } = await db()
      return sql.begin(async (tx) => {
        const [row]: { data: ChatThread }[] = await tx`
          SELECT data FROM ${t.chatThreads} WHERE id = ${id} FOR UPDATE`
        if (!row) return undefined
        const next = patchChatThread(row.data, patch)
        await tx`
          UPDATE ${t.chatThreads}
          SET updated_at = ${next.updatedAt}, archived = ${next.archived}, data = ${tx.json(next)}
          WHERE id = ${id}`
        return next
      })
    },
    async addMessage(input) {
      const { sql, t } = await db()
      return sql.begin(async (tx) => {
        await tx`SELECT 1 FROM ${t.chatThreads} WHERE id = ${input.threadId} FOR UPDATE`
        const [row]: { seq: number }[] = await tx`
          INSERT INTO ${t.chatMessages} (id, thread_id, author_id, created_at, data)
          VALUES (${input.id}, ${input.threadId}, ${input.authorId ?? null}, ${input.createdAt},
            ${tx.json(input)})
          RETURNING seq`
        if (!row) throw new Error('chat: the message was not stored')
        await tx`
          UPDATE ${t.chatThreads}
          SET updated_at = ${input.createdAt},
            data = jsonb_set(data, '{updatedAt}', to_jsonb(${input.createdAt}::text))
          WHERE id = ${input.threadId} AND updated_at COLLATE "C" < ${input.createdAt}`
        return { ...input, seq: row.seq }
      })
    },
    getMessage,
    async updateMessage(id, patch) {
      const { sql, t } = await db()
      return sql.begin(async (tx) => {
        const [row]: MessageRow[] = await tx`
          SELECT seq, data FROM ${t.chatMessages} WHERE id = ${id} FOR UPDATE`
        if (!row) return undefined
        const next: ChatMessage = {
          ...toMessage(row),
          ...(patch.card !== undefined && { card: patch.card }),
          ...(patch.body !== undefined && { body: patch.body }),
          updatedAt: patch.updatedAt,
        }
        await tx`
          UPDATE ${t.chatMessages} SET updated_at = ${patch.updatedAt}, data = ${tx.json(dataOf(next))}
          WHERE id = ${id}`
        return next
      })
    },
    async listMessages(threadId, query = {}) {
      const { sql, t } = await db()
      const size = chatPageSize(query)
      const rows: MessageRow[] =
        query.after !== undefined
          ? await sql`
              SELECT seq, data FROM ${t.chatMessages}
              WHERE thread_id = ${threadId} AND seq > ${query.after}
              ORDER BY seq LIMIT ${size}`
          : await sql`
              SELECT seq, data FROM (
                SELECT seq, data FROM ${t.chatMessages}
                WHERE thread_id = ${threadId} AND seq < ${query.before ?? 2_147_483_647}
                ORDER BY seq DESC LIMIT ${size}
              ) page ORDER BY seq`
      const page = rows.map(toMessage)
      if (query.changedSince === undefined) return page
      const seen = new Set(page.map((message) => message.id))
      const changedRows: MessageRow[] = await sql`
        SELECT seq, data FROM ${t.chatMessages}
        WHERE thread_id = ${threadId} AND updated_at IS NOT NULL
          AND updated_at COLLATE "C" >= ${query.changedSince}
        ORDER BY seq`
      const changed = changedRows.map(toMessage).filter((message) => !seen.has(message.id))
      return [...page, ...changed].toSorted((a, b) => a.seq - b.seq)
    },
    async markRead(threadId, userId, messageId) {
      const message = await getMessage(messageId)
      if (!message || message.threadId !== threadId) return
      const { sql, t } = await db()
      await sql`
        INSERT INTO ${t.chatThreadReads} AS r (thread_id, user_id, last_read_message_id, last_read_seq)
        VALUES (${threadId}, ${userId}, ${messageId}, ${message.seq})
        ON CONFLICT (thread_id, user_id) DO UPDATE SET
          last_read_message_id = excluded.last_read_message_id,
          last_read_seq = excluded.last_read_seq
        WHERE excluded.last_read_seq > r.last_read_seq`
    },
    async reads(userId) {
      const { sql, t } = await db()
      const rows: {
        thread_id: string
        user_id: string
        last_read_message_id: string
        last_read_seq: number
      }[] = await sql`
        SELECT * FROM ${t.chatThreadReads} WHERE user_id = ${userId} ORDER BY thread_id COLLATE "C"`
      return rows.map((row): ChatThreadRead => ({
        threadId: row.thread_id,
        userId: row.user_id,
        lastReadMessageId: row.last_read_message_id,
        lastReadSeq: row.last_read_seq,
      }))
    },
    async unreadCounts(userId, threadIds) {
      if (threadIds.length === 0) return {}
      const { sql, t } = await db()
      const rows: { thread_id: string; count: number }[] = await sql`
        SELECT m.thread_id, count(*)::int AS count
        FROM ${t.chatMessages} m
        LEFT JOIN ${t.chatThreadReads} r ON r.thread_id = m.thread_id AND r.user_id = ${userId}
        WHERE m.thread_id = ANY(${sql.array([...threadIds], 'TEXT')})
          AND m.seq > coalesce(r.last_read_seq, 0)
          AND (m.author_id IS NULL OR m.author_id <> ${userId})
        GROUP BY m.thread_id`
      return Object.fromEntries(rows.map((row) => [row.thread_id, row.count]))
    },
  }
}
