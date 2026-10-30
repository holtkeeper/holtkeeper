import type { ExternalAccountStore } from '@holtkeeper/store'
import { ExternalAccountConflictError } from '@holtkeeper/store'

import { isUniqueViolation } from './jobs.ts'
import { type ExternalAccountRow, toExternalAccount } from './rows.ts'
import type { Db } from './tables.ts'

/**
 * The Postgres `ExternalAccountStore`. The unique constraint on `(provider, external_id)` decides
 * conflicts atomically; `put` keeps a replaced link's place in the "oldest first" order.
 */
export function postgresExternalAccounts(db: () => Promise<Db>): ExternalAccountStore {
  return {
    async get(id) {
      const { sql, t } = await db()
      const [row]: ExternalAccountRow[] = await sql`
        SELECT * FROM ${t.externalAccounts} WHERE id = ${id}`
      return row ? toExternalAccount(row) : undefined
    },
    async find(provider, externalId) {
      const { sql, t } = await db()
      const [row]: ExternalAccountRow[] = await sql`
        SELECT * FROM ${t.externalAccounts} WHERE provider = ${provider} AND external_id = ${externalId}`
      return row ? toExternalAccount(row) : undefined
    },
    async listByUser(userId) {
      const { sql, t } = await db()
      const rows: ExternalAccountRow[] = await sql`
        SELECT * FROM ${t.externalAccounts} WHERE user_id = ${userId} ORDER BY seq`
      return rows.map(toExternalAccount)
    },
    async list(provider) {
      const { sql, t } = await db()
      const rows: ExternalAccountRow[] = await sql`
        SELECT * FROM ${t.externalAccounts}
        WHERE ${provider ?? null}::text IS NULL OR provider = ${provider ?? null}::text
        ORDER BY seq`
      return rows.map(toExternalAccount)
    },
    async put(a) {
      const { sql, t } = await db()
      try {
        await sql`
          INSERT INTO ${t.externalAccounts} (id, user_id, provider, external_id, username, verification,
            linked_by, linked_at, verified_at, challenge, principal)
          VALUES (${a.id}, ${a.userId}, ${a.provider}, ${a.externalId}, ${a.username ?? null},
            ${a.verification}, ${a.linkedBy}, ${a.linkedAt}, ${a.verifiedAt ?? null},
            ${a.challenge ? sql.json(a.challenge) : null}, ${a.principal ? sql.json(a.principal) : null})
          ON CONFLICT (id) DO UPDATE SET user_id = excluded.user_id, provider = excluded.provider,
            external_id = excluded.external_id, username = excluded.username,
            verification = excluded.verification, linked_by = excluded.linked_by,
            linked_at = excluded.linked_at, verified_at = excluded.verified_at,
            challenge = excluded.challenge, principal = excluded.principal`
      } catch (error) {
        if (isUniqueViolation(error))
          throw new ExternalAccountConflictError(a.provider, a.externalId)
        throw error
      }
    },
    async remove(id) {
      const { sql, t } = await db()
      await sql`DELETE FROM ${t.externalAccounts} WHERE id = ${id}`
    },
  }
}
