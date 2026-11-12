import type { Database } from 'bun:sqlite'

import type { SlackMessageLink, SlackMessageStore, SlackStatusReply } from '@holtkeeper/store'
import { byLinkMessage, byLinkTarget } from '@holtkeeper/store'

interface DataRow {
  data: string
}

const toLink = (row: DataRow): SlackMessageLink => JSON.parse(row.data)

const toReply = (row: DataRow): SlackStatusReply => JSON.parse(row.data)

/**
 * The SQLite `SlackMessageStore`: one JSON row per message and merge request in `slack_messages`,
 * one per status reply in `slack_replies`.
 */
export function sqliteSlackMessages(db: Database): SlackMessageStore {
  const sql = {
    upsert: db.prepare(
      `INSERT INTO slack_messages (channel, ts, repo, merge_request, created_at, data)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (channel, ts, repo, merge_request) DO UPDATE SET
         created_at = excluded.created_at, data = excluded.data`,
    ),
    ofMessage: db.query<DataRow, [string, string]>(
      'SELECT data FROM slack_messages WHERE channel = ? AND ts = ?',
    ),
    ofMergeRequest: db.query<DataRow, [string, number]>(
      'SELECT data FROM slack_messages WHERE repo = ? AND merge_request = ?',
    ),
    deleteMessage: db.prepare('DELETE FROM slack_messages WHERE channel = ? AND ts = ?'),
    deleteLink: db.prepare(
      'DELETE FROM slack_messages WHERE channel = ? AND ts = ? AND repo = ? AND merge_request = ?',
    ),
    pruneLinks: db.prepare('DELETE FROM slack_messages WHERE created_at < ?'),
    replyOf: db.query<DataRow, [string, string]>(
      'SELECT data FROM slack_replies WHERE channel = ? AND ts = ?',
    ),
    upsertReply: db.prepare(
      `INSERT INTO slack_replies (channel, ts, created_at, data) VALUES (?, ?, ?, ?)
       ON CONFLICT (channel, ts) DO UPDATE SET created_at = excluded.created_at, data = excluded.data`,
    ),
    deleteReply: db.prepare('DELETE FROM slack_replies WHERE channel = ? AND ts = ?'),
    pruneReplies: db.prepare(
      `DELETE FROM slack_replies AS r WHERE r.created_at < ? AND NOT EXISTS
         (SELECT 1 FROM slack_messages AS m WHERE m.channel = r.channel AND m.ts = r.ts)`,
    ),
  }
  const deleteMessage = db.transaction((channel: string, ts: string) => {
    sql.deleteReply.run(channel, ts)
    return sql.deleteMessage.run(channel, ts).changes
  })
  const prune = db.transaction((before: string) => {
    const deleted = sql.pruneLinks.run(before).changes
    sql.pruneReplies.run(before)
    return deleted
  })
  return {
    async put(link) {
      sql.upsert.run(
        link.channel,
        link.ts,
        link.repo,
        link.mergeRequest,
        link.createdAt,
        JSON.stringify(link),
      )
    },
    ofMessage: async (channel, ts) =>
      sql.ofMessage.all(channel, ts).map(toLink).toSorted(byLinkTarget),
    ofMergeRequest: async (repo, mergeRequest) =>
      sql.ofMergeRequest.all(repo, mergeRequest).map(toLink).toSorted(byLinkMessage),
    async delete(channel, ts, target) {
      if (target) return sql.deleteLink.run(channel, ts, target.repo, target.mergeRequest).changes
      return deleteMessage(channel, ts)
    },
    replyOf: async (channel, ts) => {
      const row = sql.replyOf.get(channel, ts)
      return row ? toReply(row) : undefined
    },
    async putReply(reply) {
      sql.upsertReply.run(reply.channel, reply.ts, reply.createdAt, JSON.stringify(reply))
    },
    async prune(before) {
      return prune(before)
    },
  }
}
