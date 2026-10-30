import type { Store } from '@holtkeeper/store'
import { SQL } from 'bun'

import { postgresExternalAccounts } from './accounts.ts'
import { postgresAiUsage } from './ai-usage.ts'
import { postgresAudit } from './audit.ts'
import { postgresConfig, postgresKv } from './config.ts'
import { postgresJobs } from './jobs.ts'
import { postgresKnowledge } from './knowledge.ts'
import { checkSchemaName, migrate } from './migrations.ts'
import {
  type ActivityRow,
  type AnalysisRow,
  type AuditRunRow,
  type CredentialRow,
  type IdentityRow,
  type LinkTokenRow,
  type PasskeyRow,
  type SettingRow,
  type UserRow,
  toActivity,
  toAnalysis,
  toAuditRun,
  toCredential,
  toIdentity,
  toLinkToken,
  toPasskey,
  toSetting,
  toUser,
} from './rows.ts'
import { type Db, tables } from './tables.ts'

/** TLS for the connection: an SSL mode, `true` for `require`, or Bun's TLS options (CA, certs). */
export type PostgresSsl =
  | boolean
  | 'disable'
  | 'prefer'
  | 'require'
  | 'verify-ca'
  | 'verify-full'
  | SQL.TLSOptions

/** Options for `postgresStore`. */
export interface PostgresStoreOptions {
  /**
   * Connection URL, `postgres://user:password@host:5432/db`, or a reference to an environment
   * variable holding it (`env('DATABASE_URL')` from `@holtkeeper/forge`). Read on first use.
   */
  url: string | { env: string }
  /** Schema that holds every table, created on first use. Lowercase letters, digits, `_`. Default `holtkeeper`. */
  schema?: string
  /** Pool size: the most connections this process opens. Default 10. */
  max?: number
  /** TLS settings; by default the URL's `sslmode` decides. */
  ssl?: PostgresSsl
}

/** A Postgres-backed `Store`. */
export interface PostgresStore extends Store {
  /**
   * Connects and applies pending migrations. Every other method does this on first use; call it
   * at startup to fail fast on a wrong URL or missing permissions.
   */
  ready(): Promise<void>
}

/** The connection URL of the options; throws when the referenced variable is unset or empty. */
export function resolveUrl(url: PostgresStoreOptions['url']): string {
  if (typeof url === 'string') return url
  const value = process.env[url.env]
  if (!value) throw new Error(`environment variable ${url.env} is not set`)
  return value
}

/**
 * A `Store` backed by PostgreSQL through Bun's built-in client (`Bun.SQL`), with every table in
 * one schema. Creating it does not connect: the pool opens and pending migrations run on the
 * first call (or `ready()`), and a failed start is retried by the next call. It behaves like
 * `memoryStore` for every contract in `describeStoreContract`. Like SQLite, passkeys, identities
 * and link tokens can only be saved for a user that exists; `removeUser` cascades to them and to
 * the user's external accounts.
 */
export function postgresStore(options: PostgresStoreOptions): PostgresStore {
  const schema = checkSchemaName(options.schema ?? 'holtkeeper')
  let client: SQL | undefined
  let starting: Promise<Db> | undefined

  const db = (): Promise<Db> =>
    (starting ??= (async () => {
      client ??= new SQL(resolveUrl(options.url), {
        max: options.max ?? 10,
        ...(options.ssl !== undefined && { tls: options.ssl }),
        connection: { application_name: 'holtkeeper', TimeZone: 'UTC' },
      })
      await migrate(client, schema)
      return { sql: client, t: tables(client, schema) }
    })().catch((error: unknown) => {
      starting = undefined
      throw error
    }))

  return {
    ...coreStores(db),
    jobs: postgresJobs(db),
    knowledge: postgresKnowledge(db, schema),
    aiUsage: postgresAiUsage(db),
    config: postgresConfig(db, schema),
    kv: postgresKv(db),
    audit: postgresAudit(db),
    externalAccounts: postgresExternalAccounts(db),
    async ready() {
      await db()
    },
    async close() {
      const open = client
      client = undefined
      starting = undefined
      await open?.close()
    },
  }
}

type CoreStores = Pick<
  Store,
  'auditRuns' | 'analyses' | 'credentials' | 'settings' | 'users' | 'activity'
>

/** The row an `INSERT ... RETURNING` produced; throws when the server returned none. */
function inserted<T>(row: T | undefined): T {
  if (row === undefined) throw new Error('insert returned no row')
  return row
}

const orNull = <T>(value: T | undefined) => value ?? null

function coreStores(db: () => Promise<Db>): CoreStores {
  return {
    auditRuns: {
      async add(run) {
        const { sql, t } = await db()
        const [row]: AuditRunRow[] = await sql`
          INSERT INTO ${t.auditRuns} (id, repo_forge, repo_path, trigger, actor, started_at, finished_at, report)
          VALUES (${crypto.randomUUID()}, ${run.repo.forge}, ${run.repo.path}, ${run.trigger}, ${orNull(run.actor)},
            ${run.startedAt}, ${run.finishedAt}, ${sql.json(run.report)})
          RETURNING *`
        return toAuditRun(inserted(row))
      },
      async get(id) {
        const { sql, t } = await db()
        const [row]: AuditRunRow[] = await sql`SELECT * FROM ${t.auditRuns} WHERE id = ${id}`
        return row ? toAuditRun(row) : undefined
      },
      async list({ repo, before, limit = 50 } = {}) {
        const { sql, t } = await db()
        const rows: AuditRunRow[] = await sql`
          SELECT * FROM ${t.auditRuns}
          WHERE (${orNull(repo?.forge)}::text IS NULL
              OR (repo_forge = ${orNull(repo?.forge)}::text AND repo_path = ${orNull(repo?.path)}::text))
            AND (${orNull(before)}::timestamptz IS NULL OR finished_at < ${orNull(before)}::timestamptz)
          ORDER BY finished_at DESC, seq DESC LIMIT ${limit}`
        return rows.map(toAuditRun)
      },
    },
    analyses: {
      async add(record) {
        const { sql, t } = await db()
        const [row]: AnalysisRow[] = await sql`
          INSERT INTO ${t.analyses} (id, repo_forge, repo_path, kind, ref, created_at, actor, data)
          VALUES (${crypto.randomUUID()}, ${record.repo.forge}, ${record.repo.path}, ${record.kind},
            ${orNull(record.ref)}, ${record.createdAt}, ${orNull(record.actor)}, ${sql.json(record.data)})
          RETURNING *`
        return toAnalysis(inserted(row))
      },
      async get(id) {
        const { sql, t } = await db()
        const [row]: AnalysisRow[] = await sql`SELECT * FROM ${t.analyses} WHERE id = ${id}`
        return row ? toAnalysis(row) : undefined
      },
      async list({ repo, kind, before, limit = 50 } = {}) {
        const { sql, t } = await db()
        const rows: AnalysisRow[] = await sql`
          SELECT * FROM ${t.analyses}
          WHERE (${orNull(repo?.forge)}::text IS NULL
              OR (repo_forge = ${orNull(repo?.forge)}::text AND repo_path = ${orNull(repo?.path)}::text))
            AND (${orNull(kind)}::text IS NULL OR kind = ${orNull(kind)}::text)
            AND (${orNull(before)}::timestamptz IS NULL OR created_at < ${orNull(before)}::timestamptz)
          ORDER BY created_at DESC, seq DESC LIMIT ${limit}`
        return rows.map(toAnalysis)
      },
    },
    credentials: {
      async list() {
        const { sql, t } = await db()
        const rows: CredentialRow[] = await sql`SELECT * FROM ${t.credentials} ORDER BY seq`
        return rows.map(toCredential)
      },
      async get(id) {
        const { sql, t } = await db()
        const [row]: CredentialRow[] = await sql`SELECT * FROM ${t.credentials} WHERE id = ${id}`
        return row ? toCredential(row) : undefined
      },
      async put(c) {
        const { sql, t } = await db()
        await sql`
          INSERT INTO ${t.credentials} (id, name, kind, url, scope, secret, expires_at, rotation,
            last_rotated_at, last_error, options, created_at, updated_at)
          VALUES (${c.id}, ${c.name}, ${c.kind}, ${c.url}, ${sql.json(c.scope)}, ${c.secret},
            ${orNull(c.expiresAt)}, ${c.rotation ? sql.json(c.rotation) : null}, ${orNull(c.lastRotatedAt)},
            ${orNull(c.lastError)}, ${c.options ? sql.json(c.options) : null}, ${c.createdAt}, ${c.updatedAt})
          ON CONFLICT (id) DO UPDATE SET name = excluded.name, kind = excluded.kind, url = excluded.url,
            scope = excluded.scope, secret = excluded.secret, expires_at = excluded.expires_at,
            rotation = excluded.rotation, last_rotated_at = excluded.last_rotated_at,
            last_error = excluded.last_error, options = excluded.options,
            created_at = excluded.created_at, updated_at = excluded.updated_at`
      },
      async remove(id) {
        const { sql, t } = await db()
        await sql`DELETE FROM ${t.credentials} WHERE id = ${id}`
      },
    },
    settings: {
      async list(key) {
        const { sql, t } = await db()
        const rows: SettingRow[] = await sql`
          SELECT * FROM ${t.settings}
          WHERE (${orNull(key)}::text IS NULL OR key = ${orNull(key)}::text) ORDER BY seq`
        return rows.map(toSetting)
      },
      async get(id) {
        const { sql, t } = await db()
        const [row]: SettingRow[] = await sql`SELECT * FROM ${t.settings} WHERE id = ${id}`
        return row ? toSetting(row) : undefined
      },
      async put(e) {
        const { sql, t } = await db()
        await sql`
          INSERT INTO ${t.settings} (id, key, scope, value, secret, updated_at, updated_by)
          VALUES (${e.id}, ${e.key}, ${sql.json(e.scope)}, ${sql.json(e.value ?? null)}, ${e.secret},
            ${e.updatedAt}, ${orNull(e.updatedBy)})
          ON CONFLICT (id) DO UPDATE SET key = excluded.key, scope = excluded.scope,
            value = excluded.value, secret = excluded.secret, updated_at = excluded.updated_at,
            updated_by = excluded.updated_by`
      },
      async remove(id) {
        const { sql, t } = await db()
        await sql`DELETE FROM ${t.settings} WHERE id = ${id}`
      },
    },
    users: {
      async listUsers() {
        const { sql, t } = await db()
        const rows: UserRow[] = await sql`SELECT * FROM ${t.users} ORDER BY seq`
        return rows.map(toUser)
      },
      async getUser(id) {
        const { sql, t } = await db()
        const [row]: UserRow[] = await sql`SELECT * FROM ${t.users} WHERE id = ${id}`
        return row ? toUser(row) : undefined
      },
      async findUserByEmail(email) {
        const { sql, t } = await db()
        const [row]: UserRow[] = await sql`
          SELECT * FROM ${t.users} WHERE email_lower = ${email.toLowerCase()} ORDER BY seq LIMIT 1`
        return row ? toUser(row) : undefined
      },
      async putUser(u) {
        const { sql, t } = await db()
        await sql`
          INSERT INTO ${t.users} (id, name, email, email_lower, grants, disabled, session_version,
            created_at, created_by, avatar_seed)
          VALUES (${u.id}, ${u.name}, ${orNull(u.email)}, ${u.email?.toLowerCase() ?? null},
            ${sql.json(u.grants)}, ${u.disabled}, ${u.sessionVersion}, ${u.createdAt}, ${orNull(u.createdBy)},
            ${orNull(u.avatarSeed)})
          ON CONFLICT (id) DO UPDATE SET name = excluded.name, email = excluded.email,
            email_lower = excluded.email_lower, grants = excluded.grants, disabled = excluded.disabled,
            session_version = excluded.session_version, created_at = excluded.created_at,
            created_by = excluded.created_by, avatar_seed = excluded.avatar_seed`
      },
      async removeUser(id) {
        const { sql, t } = await db()
        await sql.begin(async (tx) => {
          await tx`DELETE FROM ${t.externalAccounts} WHERE user_id = ${id}`
          await tx`DELETE FROM ${t.users} WHERE id = ${id}`
        })
      },
      async listPasskeys(userId) {
        const { sql, t } = await db()
        const rows: PasskeyRow[] = await sql`
          SELECT * FROM ${t.passkeys} WHERE user_id = ${userId} ORDER BY seq`
        return rows.map(toPasskey)
      },
      async getPasskey(id) {
        const { sql, t } = await db()
        const [row]: PasskeyRow[] = await sql`SELECT * FROM ${t.passkeys} WHERE id = ${id}`
        return row ? toPasskey(row) : undefined
      },
      async putPasskey(p) {
        const { sql, t } = await db()
        await sql`
          INSERT INTO ${t.passkeys} (id, user_id, public_key, counter, transports, label, created_at, last_used_at)
          VALUES (${p.id}, ${p.userId}, ${p.publicKey}, ${p.counter},
            ${p.transports ? sql.json(p.transports) : null}, ${orNull(p.label)}, ${p.createdAt},
            ${orNull(p.lastUsedAt)})
          ON CONFLICT (id) DO UPDATE SET user_id = excluded.user_id, public_key = excluded.public_key,
            counter = excluded.counter, transports = excluded.transports, label = excluded.label,
            created_at = excluded.created_at, last_used_at = excluded.last_used_at`
      },
      async removePasskey(id) {
        const { sql, t } = await db()
        await sql`DELETE FROM ${t.passkeys} WHERE id = ${id}`
      },
      async findIdentity(provider, subject) {
        const { sql, t } = await db()
        const [row]: IdentityRow[] = await sql`
          SELECT * FROM ${t.identities} WHERE provider = ${provider} AND subject = ${subject}`
        return row ? toIdentity(row) : undefined
      },
      async listIdentities(userId) {
        const { sql, t } = await db()
        const rows: IdentityRow[] = await sql`
          SELECT * FROM ${t.identities} WHERE user_id = ${userId} ORDER BY provider, subject`
        return rows.map(toIdentity)
      },
      async putIdentity(i) {
        const { sql, t } = await db()
        await sql`
          INSERT INTO ${t.identities} (provider, subject, user_id, email)
          VALUES (${i.provider}, ${i.subject}, ${i.userId}, ${orNull(i.email)})
          ON CONFLICT (provider, subject) DO UPDATE SET user_id = excluded.user_id, email = excluded.email`
      },
      async putLinkToken(token) {
        const { sql, t } = await db()
        await sql`
          INSERT INTO ${t.linkTokens} (token_hash, user_id, purpose, expires_at, used_at, created_by)
          VALUES (${token.tokenHash}, ${token.userId}, ${token.purpose}, ${token.expiresAt},
            ${orNull(token.usedAt)}, ${orNull(token.createdBy)})
          ON CONFLICT (token_hash) DO UPDATE SET user_id = excluded.user_id, purpose = excluded.purpose,
            expires_at = excluded.expires_at, used_at = excluded.used_at, created_by = excluded.created_by`
      },
      async getLinkToken(hash) {
        const { sql, t } = await db()
        const [row]: LinkTokenRow[] = await sql`
          SELECT * FROM ${t.linkTokens} WHERE token_hash = ${hash}`
        return row ? toLinkToken(row) : undefined
      },
    },
    activity: {
      async append(event) {
        const { sql, t } = await db()
        const [row]: ActivityRow[] = await sql`
          INSERT INTO ${t.activity} (id, at, actor, action, subject, details)
          VALUES (${crypto.randomUUID()}, ${event.at}, ${event.actor}, ${event.action}, ${orNull(event.subject)},
            ${event.details ? sql.json(event.details) : null})
          RETURNING *`
        return toActivity(inserted(row))
      },
      async list({ before, limit = 50 } = {}) {
        const { sql, t } = await db()
        const rows: ActivityRow[] = await sql`
          SELECT * FROM ${t.activity}
          WHERE (${orNull(before)}::timestamptz IS NULL OR at < ${orNull(before)}::timestamptz)
          ORDER BY at DESC, seq DESC LIMIT ${limit}`
        return rows.map(toActivity)
      },
    },
  }
}
