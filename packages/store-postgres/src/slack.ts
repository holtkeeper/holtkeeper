import type { SlackMessageLink, SlackMessageStore, SlackStatusReply } from '@holtkeeper/store'
import { byLinkMessage, byLinkTarget } from '@holtkeeper/store'

import type { Db } from './tables.ts'

/**
 * The Postgres `SlackMessageStore`: one JSON row per message and merge request in
 * `slack_messages`, one per status reply in `slack_replies`.
 */
export function postgresSlackMessages(db: () => Promise<Db>): SlackMessageStore {
  return {
    async put(link) {
      const { sql, t } = await db()
      await sql`
        INSERT INTO ${t.slackMessages} (channel, ts, repo, merge_request, created_at, data)
        VALUES (${link.channel}, ${link.ts}, ${link.repo}, ${link.mergeRequest}, ${link.createdAt},
          ${sql.json(link)})
        ON CONFLICT (channel, ts, repo, merge_request) DO UPDATE SET
          created_at = excluded.created_at, data = excluded.data`
    },
    async ofMessage(channel, ts) {
      const { sql, t } = await db()
      const rows: { data: SlackMessageLink }[] = await sql`
        SELECT data FROM ${t.slackMessages} WHERE channel = ${channel} AND ts = ${ts}`
      return rows.map((row) => row.data).toSorted(byLinkTarget)
    },
    async ofMergeRequest(repo, mergeRequest) {
      const { sql, t } = await db()
      const rows: { data: SlackMessageLink }[] = await sql`
        SELECT data FROM ${t.slackMessages}
        WHERE repo = ${repo} AND merge_request = ${mergeRequest}`
      return rows.map((row) => row.data).toSorted(byLinkMessage)
    },
    async delete(channel, ts, target) {
      const { sql, t } = await db()
      if (target) {
        const deleted = await sql`
          DELETE FROM ${t.slackMessages}
          WHERE channel = ${channel} AND ts = ${ts} AND repo = ${target.repo}
            AND merge_request = ${target.mergeRequest}
          RETURNING ts`
        return deleted.length
      }
      return sql.begin(async (tx) => {
        await tx`DELETE FROM ${t.slackReplies} WHERE channel = ${channel} AND ts = ${ts}`
        const deleted = await tx`
          DELETE FROM ${t.slackMessages} WHERE channel = ${channel} AND ts = ${ts} RETURNING ts`
        return deleted.length
      })
    },
    async replyOf(channel, ts) {
      const { sql, t } = await db()
      const [row]: { data: SlackStatusReply }[] = await sql`
        SELECT data FROM ${t.slackReplies} WHERE channel = ${channel} AND ts = ${ts}`
      return row?.data
    },
    async putReply(reply) {
      const { sql, t } = await db()
      await sql`
        INSERT INTO ${t.slackReplies} (channel, ts, created_at, data)
        VALUES (${reply.channel}, ${reply.ts}, ${reply.createdAt}, ${sql.json(reply)})
        ON CONFLICT (channel, ts) DO UPDATE SET
          created_at = excluded.created_at, data = excluded.data`
    },
    async prune(before) {
      const { sql, t } = await db()
      return sql.begin(async (tx) => {
        const deleted = await tx`
          DELETE FROM ${t.slackMessages} WHERE created_at < ${before} RETURNING ts`
        await tx`
          DELETE FROM ${t.slackReplies} AS r WHERE r.created_at < ${before} AND NOT EXISTS
            (SELECT 1 FROM ${t.slackMessages} AS m WHERE m.channel = r.channel AND m.ts = r.ts)`
        return deleted.length
      })
    },
  }
}
