import type { Database } from 'bun:sqlite'

import type { ExternalAccount, ExternalAccountStore } from '@holtkeeper/store'
import { ExternalAccountConflictError } from '@holtkeeper/store'

interface AccountRow {
  id: string
  user_id: string
  provider: string
  external_id: string
  username: string | null
  verification: ExternalAccount['verification']
  linked_by: string
  linked_at: string
  verified_at: string | null
  challenge: string | null
  principal: string | null
}

const toAccount = (r: AccountRow): ExternalAccount => ({
  id: r.id,
  userId: r.user_id,
  provider: r.provider,
  externalId: r.external_id,
  ...(r.username !== null && { username: r.username }),
  verification: r.verification,
  linkedBy: r.linked_by,
  linkedAt: r.linked_at,
  ...(r.verified_at !== null && { verifiedAt: r.verified_at }),
  ...(r.challenge !== null && { challenge: JSON.parse(r.challenge) }),
  ...(r.principal !== null && { principal: JSON.parse(r.principal) }),
})

/** The SQLite `ExternalAccountStore` on `external_accounts`; `(provider, external_id)` is unique. */
export function sqliteExternalAccounts(db: Database): ExternalAccountStore {
  const get = db.query<AccountRow, [string]>('SELECT * FROM external_accounts WHERE id = ?')
  const find = db.query<AccountRow, [string, string]>(
    'SELECT * FROM external_accounts WHERE provider = ? AND external_id = ?',
  )
  const byUser = db.query<AccountRow, [string]>(
    'SELECT * FROM external_accounts WHERE user_id = ? ORDER BY seq',
  )
  const all = db.query<AccountRow, [string | null]>(
    'SELECT * FROM external_accounts WHERE (?1 IS NULL OR provider = ?1) ORDER BY seq',
  )
  const upsert = db.prepare(
    `INSERT INTO external_accounts (id, user_id, provider, external_id, username, verification, linked_by, linked_at, verified_at, challenge, principal)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET user_id = excluded.user_id, provider = excluded.provider,
       external_id = excluded.external_id, username = excluded.username, verification = excluded.verification,
       linked_by = excluded.linked_by, linked_at = excluded.linked_at, verified_at = excluded.verified_at,
       challenge = excluded.challenge, principal = excluded.principal`,
  )
  const remove = db.prepare('DELETE FROM external_accounts WHERE id = ?')

  const put = db.transaction((a: ExternalAccount) => {
    const holder = find.get(a.provider, a.externalId)
    if (holder && holder.id !== a.id)
      throw new ExternalAccountConflictError(a.provider, a.externalId)
    upsert.run(
      a.id,
      a.userId,
      a.provider,
      a.externalId,
      a.username ?? null,
      a.verification,
      a.linkedBy,
      a.linkedAt,
      a.verifiedAt ?? null,
      a.challenge ? JSON.stringify(a.challenge) : null,
      a.principal ? JSON.stringify(a.principal) : null,
    )
  })

  return {
    async get(id) {
      const row = get.get(id)
      return row ? toAccount(row) : undefined
    },
    async find(provider, externalId) {
      const row = find.get(provider, externalId)
      return row ? toAccount(row) : undefined
    },
    listByUser: async (userId) => byUser.all(userId).map(toAccount),
    list: async (provider) => all.all(provider ?? null).map(toAccount),
    put: async (account) => put.immediate(account),
    remove: async (id) => void remove.run(id),
  }
}
