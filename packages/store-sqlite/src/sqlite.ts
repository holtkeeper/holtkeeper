import { Database } from 'bun:sqlite'

import type {
  AnalysisRecord,
  AuditRun,
  Identity,
  Job,
  JobSearch,
  JobStatus,
  JobStore,
  LinkToken,
  Passkey,
  SettingEntry,
  Store,
  StoredCredential,
  User,
} from '@holtkeeper/store'
import {
  claimDueBy,
  DEFAULT_MAX_ATTEMPTS,
  errorSignature,
  jobCounts,
  likeText,
  STALE_JOB_ERROR,
} from '@holtkeeper/store'

import { sqliteExternalAccounts } from './accounts.ts'
import { sqliteAiUsage } from './ai-usage.ts'
import { sqliteAudit } from './audit.ts'
import { sqliteChat } from './chat.ts'
import { sqliteCiJobs } from './ci-jobs.ts'
import { sqliteConfig, sqliteKv } from './config.ts'
import { sqliteDatabase } from './database.ts'
import { sqliteFamilies, sqliteGuides } from './guides.ts'
import { sqliteKnowledge } from './knowledge.ts'
import { sqliteLearnings } from './learnings.ts'
import { sqliteLibraries } from './libraries.ts'
import { migrate } from './migrations.ts'
import { sqliteSlackMessages } from './slack.ts'
import { sqliteTasks } from './tasks.ts'

/** Options for `sqliteStore`. */
export interface SqliteStoreOptions {
  /** Database file path, or `:memory:` for a private in-memory database. Created if missing. */
  path: string
}

const json = (value: unknown) => JSON.stringify(value)
const orNull = <T>(value: T | undefined) => value ?? null

interface AuditRunRow {
  id: string
  repo_forge: string
  repo_path: string
  trigger: AuditRun['trigger']
  actor: string | null
  started_at: string
  finished_at: string
  report: string
}

const toAuditRun = (r: AuditRunRow): AuditRun => ({
  id: r.id,
  repo: { forge: r.repo_forge, path: r.repo_path },
  trigger: r.trigger,
  ...(r.actor !== null && { actor: r.actor }),
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  report: JSON.parse(r.report),
})

interface AnalysisRow {
  id: string
  repo_forge: string
  repo_path: string
  kind: string
  ref: string | null
  sha: string | null
  created_at: string
  actor: string | null
  data: string
  metrics: string | null
}

const toAnalysis = (r: AnalysisRow): AnalysisRecord => ({
  id: r.id,
  repo: { forge: r.repo_forge, path: r.repo_path },
  kind: r.kind,
  ...(r.ref !== null && { ref: r.ref }),
  ...(r.sha !== null && { sha: r.sha }),
  createdAt: r.created_at,
  ...(r.actor !== null && { actor: r.actor }),
  data: JSON.parse(r.data),
  ...(r.metrics !== null && { metrics: JSON.parse(r.metrics) }),
})

interface CredentialRow {
  id: string
  name: string
  kind: string
  url: string
  scope: string
  secret: string
  expires_at: string | null
  rotation: string | null
  last_rotated_at: string | null
  last_error: string | null
  options: string | null
  capabilities: string | null
  last_used_at: string | null
  created_at: string
  updated_at: string
}

const toCredential = (r: CredentialRow): StoredCredential => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  url: r.url,
  scope: JSON.parse(r.scope),
  secret: r.secret,
  ...(r.expires_at !== null && { expiresAt: r.expires_at }),
  ...(r.rotation !== null && { rotation: JSON.parse(r.rotation) }),
  ...(r.last_rotated_at !== null && { lastRotatedAt: r.last_rotated_at }),
  ...(r.last_error !== null && { lastError: r.last_error }),
  ...(r.options !== null && { options: JSON.parse(r.options) }),
  ...(r.capabilities !== null && { capabilities: JSON.parse(r.capabilities) }),
  ...(r.last_used_at !== null && { lastUsedAt: r.last_used_at }),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

interface SettingRow {
  id: string
  key: string
  scope: string
  value: string
  secret: number
  updated_at: string
  updated_by: string | null
}

const toSetting = (r: SettingRow): SettingEntry => ({
  id: r.id,
  key: r.key,
  scope: JSON.parse(r.scope),
  value: JSON.parse(r.value),
  secret: r.secret === 1,
  updatedAt: r.updated_at,
  ...(r.updated_by !== null && { updatedBy: r.updated_by }),
})

interface UserRow {
  id: string
  name: string
  email: string | null
  grants: string
  disabled: number
  session_version: number
  created_at: string
  created_by: string | null
  avatar_seed: string | null
  last_seen_at: string | null
}

const toUser = (r: UserRow): User => ({
  id: r.id,
  name: r.name,
  ...(r.email !== null && { email: r.email }),
  grants: JSON.parse(r.grants),
  disabled: r.disabled === 1,
  sessionVersion: r.session_version,
  createdAt: r.created_at,
  ...(r.created_by !== null && { createdBy: r.created_by }),
  ...(r.avatar_seed !== null && { avatarSeed: r.avatar_seed }),
  ...(r.last_seen_at !== null && { lastSeenAt: r.last_seen_at }),
})

interface PasskeyRow {
  id: string
  user_id: string
  public_key: string
  counter: number
  transports: string | null
  label: string | null
  created_at: string
  last_used_at: string | null
}

const toPasskey = (r: PasskeyRow): Passkey => ({
  id: r.id,
  userId: r.user_id,
  publicKey: r.public_key,
  counter: r.counter,
  ...(r.transports !== null && { transports: JSON.parse(r.transports) }),
  ...(r.label !== null && { label: r.label }),
  createdAt: r.created_at,
  ...(r.last_used_at !== null && { lastUsedAt: r.last_used_at }),
})

interface IdentityRow {
  provider: string
  subject: string
  user_id: string
  email: string | null
}

const toIdentity = (r: IdentityRow): Identity => ({
  provider: r.provider,
  subject: r.subject,
  userId: r.user_id,
  ...(r.email !== null && { email: r.email }),
})

interface LinkTokenRow {
  token_hash: string
  user_id: string
  purpose: LinkToken['purpose']
  expires_at: string
  used_at: string | null
  created_by: string | null
}

const toLinkToken = (r: LinkTokenRow): LinkToken => ({
  tokenHash: r.token_hash,
  userId: r.user_id,
  purpose: r.purpose,
  expiresAt: r.expires_at,
  ...(r.used_at !== null && { usedAt: r.used_at }),
  ...(r.created_by !== null && { createdBy: r.created_by }),
})

/**
 * A `Store` backed by SQLite (`bun:sqlite`). Opens the database in WAL mode with foreign keys on,
 * applies pending schema migrations, and behaves exactly like `memoryStore` for every contract in
 * `describeStoreContract`. One caveat: passkeys, identities and link tokens reference their user,
 * so they can only be saved for a user that exists.
 */
export function sqliteStore({ path }: SqliteStoreOptions): Store {
  const db = new Database(path, { create: true, strict: true })
  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA foreign_keys = ON')
  db.run('PRAGMA busy_timeout = 5000')
  migrate(db)

  const sql = {
    runInsert: db.prepare(
      `INSERT INTO audit_runs (id, repo_forge, repo_path, trigger, actor, started_at, finished_at, report)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    runGet: db.query<AuditRunRow, [string]>('SELECT * FROM audit_runs WHERE id = ?'),
    runList: db.query<AuditRunRow, [string | null, string | null, string | null, number]>(
      `SELECT * FROM audit_runs
       WHERE (?1 IS NULL OR (repo_forge = ?1 AND repo_path = ?2)) AND (?3 IS NULL OR finished_at < ?3)
       ORDER BY finished_at DESC, seq DESC LIMIT ?4`,
    ),
    analysisInsert: db.prepare(
      `INSERT INTO analyses (id, repo_forge, repo_path, kind, ref, sha, created_at, actor, data, metrics)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    analysisGet: db.query<AnalysisRow, [string]>('SELECT * FROM analyses WHERE id = ?'),
    analysisList: db.query<
      AnalysisRow,
      [string | null, string | null, string | null, string | null, string | null, number]
    >(
      `SELECT * FROM analyses
       WHERE (?1 IS NULL OR (repo_forge = ?1 AND repo_path = ?2)) AND (?3 IS NULL OR kind = ?3)
         AND (?4 IS NULL OR created_at < ?4) AND (?5 IS NULL OR created_at >= ?5)
       ORDER BY created_at DESC, seq DESC LIMIT ?6`,
    ),
    analysisHeads: db.query<
      AnalysisRow,
      [string | null, string | null, string | null, string | null, string | null, number]
    >(
      `SELECT seq, id, repo_forge, repo_path, kind, ref, sha, created_at, actor, 'null' AS data, metrics FROM analyses
       WHERE (?1 IS NULL OR (repo_forge = ?1 AND repo_path = ?2)) AND (?3 IS NULL OR kind = ?3)
         AND (?4 IS NULL OR created_at < ?4) AND (?5 IS NULL OR created_at >= ?5)
       ORDER BY created_at DESC, seq DESC LIMIT ?6`,
    ),
    analysisLatest: db.query<AnalysisRow, [string | null, string | null, string | null]>(
      `SELECT * FROM analyses WHERE seq IN (
         SELECT seq FROM (
           SELECT seq, ROW_NUMBER() OVER (
             PARTITION BY repo_forge, repo_path, kind ORDER BY created_at DESC, seq DESC) AS n
           FROM analyses
           WHERE (?1 IS NULL OR (repo_forge = ?1 AND repo_path = ?2)) AND (?3 IS NULL OR kind = ?3))
         WHERE n = 1)
       ORDER BY created_at DESC, seq DESC`,
    ),
    analysisLatestHeads: db.query<AnalysisRow, [string | null, string | null, string | null]>(
      `SELECT seq, id, repo_forge, repo_path, kind, ref, sha, created_at, actor, 'null' AS data, metrics
       FROM analyses WHERE seq IN (
         SELECT seq FROM (
           SELECT seq, ROW_NUMBER() OVER (
             PARTITION BY repo_forge, repo_path, kind ORDER BY created_at DESC, seq DESC) AS n
           FROM analyses
           WHERE (?1 IS NULL OR (repo_forge = ?1 AND repo_path = ?2)) AND (?3 IS NULL OR kind = ?3))
         WHERE n = 1)
       ORDER BY created_at DESC, seq DESC`,
    ),
    analysisPrune: db.prepare<unknown, [string, string, string, number]>(
      `DELETE FROM analyses
       WHERE repo_forge = ?1 AND repo_path = ?2 AND kind = ?3 AND seq NOT IN (
         SELECT seq FROM analyses WHERE repo_forge = ?1 AND repo_path = ?2 AND kind = ?3
         ORDER BY created_at DESC, seq DESC LIMIT ?4)`,
    ),
    credList: db.query<CredentialRow, []>('SELECT * FROM credentials ORDER BY seq'),
    credGet: db.query<CredentialRow, [string]>('SELECT * FROM credentials WHERE id = ?'),
    credPut: db.prepare(
      `INSERT INTO credentials (id, name, kind, url, scope, secret, expires_at, rotation, last_rotated_at, last_error, options, capabilities, created_at, updated_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, kind = excluded.kind, url = excluded.url, scope = excluded.scope,
         secret = excluded.secret, expires_at = excluded.expires_at, rotation = excluded.rotation,
         last_rotated_at = excluded.last_rotated_at, last_error = excluded.last_error, options = excluded.options,
         capabilities = excluded.capabilities, created_at = excluded.created_at, updated_at = excluded.updated_at,
         last_used_at = max(coalesce(last_used_at, excluded.last_used_at), coalesce(excluded.last_used_at, last_used_at))`,
    ),
    credRemove: db.prepare('DELETE FROM credentials WHERE id = ?'),
    credTouch: db.prepare<unknown, [string, string]>(
      'UPDATE credentials SET last_used_at = ?1 WHERE id = ?2 AND (last_used_at IS NULL OR last_used_at < ?1)',
    ),
    settingList: db.query<SettingRow, [string | null]>(
      'SELECT * FROM settings WHERE (?1 IS NULL OR key = ?1) ORDER BY seq',
    ),
    settingGet: db.query<SettingRow, [string]>('SELECT * FROM settings WHERE id = ?'),
    settingPut: db.prepare(
      `INSERT INTO settings (id, key, scope, value, secret, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET key = excluded.key, scope = excluded.scope, value = excluded.value,
         secret = excluded.secret, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    ),
    settingRemove: db.prepare('DELETE FROM settings WHERE id = ?'),
    userList: db.query<UserRow, []>('SELECT * FROM users ORDER BY seq'),
    userGet: db.query<UserRow, [string]>('SELECT * FROM users WHERE id = ?'),
    userByEmail: db.query<UserRow, [string]>(
      'SELECT * FROM users WHERE email_lower = ? ORDER BY seq LIMIT 1',
    ),
    userPut: db.prepare(
      `INSERT INTO users (id, name, email, email_lower, grants, disabled, session_version, created_at, created_by, avatar_seed, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, email = excluded.email, email_lower = excluded.email_lower,
         grants = excluded.grants, disabled = excluded.disabled, session_version = excluded.session_version,
         created_at = excluded.created_at, created_by = excluded.created_by, avatar_seed = excluded.avatar_seed,
         last_seen_at = max(coalesce(last_seen_at, excluded.last_seen_at), coalesce(excluded.last_seen_at, last_seen_at))`,
    ),
    userRemove: db.prepare('DELETE FROM users WHERE id = ?'),
    userTouch: db.prepare<unknown, [string, string]>(
      'UPDATE users SET last_seen_at = ?1 WHERE id = ?2 AND (last_seen_at IS NULL OR last_seen_at < ?1)',
    ),
    userAccountsRemove: db.prepare('DELETE FROM external_accounts WHERE user_id = ?'),
    passkeyList: db.query<PasskeyRow, [string]>(
      'SELECT * FROM passkeys WHERE user_id = ? ORDER BY seq',
    ),
    passkeyGet: db.query<PasskeyRow, [string]>('SELECT * FROM passkeys WHERE id = ?'),
    passkeyPut: db.prepare(
      `INSERT INTO passkeys (id, user_id, public_key, counter, transports, label, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET user_id = excluded.user_id, public_key = excluded.public_key, counter = excluded.counter,
         transports = excluded.transports, label = excluded.label, created_at = excluded.created_at,
         last_used_at = excluded.last_used_at`,
    ),
    passkeyRemove: db.prepare('DELETE FROM passkeys WHERE id = ?'),
    identityGet: db.query<IdentityRow, [string, string]>(
      'SELECT * FROM identities WHERE provider = ? AND subject = ?',
    ),
    identityListByUser: db.query<IdentityRow, [string]>(
      'SELECT * FROM identities WHERE user_id = ? ORDER BY provider, subject',
    ),
    identityPut: db.prepare(
      `INSERT INTO identities (provider, subject, user_id, email) VALUES (?, ?, ?, ?)
       ON CONFLICT (provider, subject) DO UPDATE SET user_id = excluded.user_id, email = excluded.email`,
    ),
    tokenGet: db.query<LinkTokenRow, [string]>('SELECT * FROM link_tokens WHERE token_hash = ?'),
    tokenPut: db.prepare(
      `INSERT INTO link_tokens (token_hash, user_id, purpose, expires_at, used_at, created_by) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (token_hash) DO UPDATE SET user_id = excluded.user_id, purpose = excluded.purpose,
         expires_at = excluded.expires_at, used_at = excluded.used_at, created_by = excluded.created_by`,
    ),
  }

  return {
    auditRuns: {
      async add(run) {
        const stored: AuditRun = { ...run, id: crypto.randomUUID() }
        sql.runInsert.run(
          stored.id,
          run.repo.forge,
          run.repo.path,
          run.trigger,
          orNull(run.actor),
          run.startedAt,
          run.finishedAt,
          json(run.report),
        )
        return stored
      },
      async get(id) {
        const row = sql.runGet.get(id)
        return row ? toAuditRun(row) : undefined
      },
      async list({ repo, before, limit = 50 } = {}) {
        return sql.runList
          .all(orNull(repo?.forge), orNull(repo?.path), orNull(before), limit)
          .map(toAuditRun)
      },
    },
    analyses: {
      async add(record) {
        const stored: AnalysisRecord = { ...record, id: crypto.randomUUID() }
        sql.analysisInsert.run(
          stored.id,
          record.repo.forge,
          record.repo.path,
          record.kind,
          orNull(record.ref),
          orNull(record.sha),
          record.createdAt,
          orNull(record.actor),
          json(record.data),
          record.metrics === undefined ? null : json(record.metrics),
        )
        return stored
      },
      async get(id) {
        const row = sql.analysisGet.get(id)
        return row ? toAnalysis(row) : undefined
      },
      async list({ repo, kind, before, since, limit = 50 } = {}) {
        return sql.analysisList
          .all(
            orNull(repo?.forge),
            orNull(repo?.path),
            orNull(kind),
            orNull(before),
            orNull(since),
            limit,
          )
          .map(toAnalysis)
      },
      async heads({ repo, kind, before, since, limit = 50 } = {}) {
        return sql.analysisHeads
          .all(
            orNull(repo?.forge),
            orNull(repo?.path),
            orNull(kind),
            orNull(before),
            orNull(since),
            limit,
          )
          .map((row) => {
            const { data: _, ...head } = toAnalysis(row)
            return head
          })
      },
      async latest({ repo, kind } = {}) {
        return sql.analysisLatest
          .all(orNull(repo?.forge), orNull(repo?.path), orNull(kind))
          .map(toAnalysis)
      },
      async latestHeads({ repo, kind } = {}) {
        return sql.analysisLatestHeads
          .all(orNull(repo?.forge), orNull(repo?.path), orNull(kind))
          .map((row) => {
            const { data: _, ...head } = toAnalysis(row)
            return head
          })
      },
      async prune({ repo, kind, keep }) {
        return sql.analysisPrune.run(repo.forge, repo.path, kind, Math.max(keep, 0)).changes
      },
    },
    credentials: {
      async list() {
        return sql.credList.all().map(toCredential)
      },
      async get(id) {
        const row = sql.credGet.get(id)
        return row ? toCredential(row) : undefined
      },
      async put(c) {
        sql.credPut.run(
          c.id,
          c.name,
          c.kind,
          c.url,
          json(c.scope),
          c.secret,
          orNull(c.expiresAt),
          c.rotation ? json(c.rotation) : null,
          orNull(c.lastRotatedAt),
          orNull(c.lastError),
          c.options ? json(c.options) : null,
          c.capabilities ? json(c.capabilities) : null,
          c.createdAt,
          c.updatedAt,
          orNull(c.lastUsedAt),
        )
      },
      async remove(id) {
        sql.credRemove.run(id)
      },
      async touch(id, at) {
        sql.credTouch.run(at, id)
      },
    },
    settings: {
      async list(key) {
        return sql.settingList.all(orNull(key)).map(toSetting)
      },
      async get(id) {
        const row = sql.settingGet.get(id)
        return row ? toSetting(row) : undefined
      },
      async put(e) {
        sql.settingPut.run(
          e.id,
          e.key,
          json(e.scope),
          json(e.value),
          e.secret ? 1 : 0,
          e.updatedAt,
          orNull(e.updatedBy),
        )
      },
      async remove(id) {
        sql.settingRemove.run(id)
      },
    },
    users: {
      async listUsers() {
        return sql.userList.all().map(toUser)
      },
      async getUser(id) {
        const row = sql.userGet.get(id)
        return row ? toUser(row) : undefined
      },
      async findUserByEmail(email) {
        const row = sql.userByEmail.get(email.toLowerCase())
        return row ? toUser(row) : undefined
      },
      async putUser(u) {
        sql.userPut.run(
          u.id,
          u.name,
          orNull(u.email),
          u.email?.toLowerCase() ?? null,
          json(u.grants),
          u.disabled ? 1 : 0,
          u.sessionVersion,
          u.createdAt,
          orNull(u.createdBy),
          orNull(u.avatarSeed),
          orNull(u.lastSeenAt),
        )
      },
      async touchUser(id, at) {
        sql.userTouch.run(at, id)
      },
      async removeUser(id) {
        db.transaction(() => {
          sql.userRemove.run(id)
          sql.userAccountsRemove.run(id)
        })()
      },
      async listPasskeys(userId) {
        return sql.passkeyList.all(userId).map(toPasskey)
      },
      async getPasskey(id) {
        const row = sql.passkeyGet.get(id)
        return row ? toPasskey(row) : undefined
      },
      async putPasskey(p) {
        sql.passkeyPut.run(
          p.id,
          p.userId,
          p.publicKey,
          p.counter,
          p.transports ? json(p.transports) : null,
          orNull(p.label),
          p.createdAt,
          orNull(p.lastUsedAt),
        )
      },
      async removePasskey(id) {
        sql.passkeyRemove.run(id)
      },
      async findIdentity(provider, subject) {
        const row = sql.identityGet.get(provider, subject)
        return row ? toIdentity(row) : undefined
      },
      async listIdentities(userId) {
        return sql.identityListByUser.all(userId).map(toIdentity)
      },
      async putIdentity(i) {
        sql.identityPut.run(i.provider, i.subject, i.userId, orNull(i.email))
      },
      async putLinkToken(t) {
        sql.tokenPut.run(
          t.tokenHash,
          t.userId,
          t.purpose,
          t.expiresAt,
          orNull(t.usedAt),
          orNull(t.createdBy),
        )
      },
      async getLinkToken(hash) {
        const row = sql.tokenGet.get(hash)
        return row ? toLinkToken(row) : undefined
      },
    },
    jobs: sqliteJobs(db),
    knowledge: sqliteKnowledge(db),
    guides: sqliteGuides(db),
    families: sqliteFamilies(db),
    learnings: sqliteLearnings(db),
    tasks: sqliteTasks(db),
    aiUsage: sqliteAiUsage(db),
    ciJobs: sqliteCiJobs(db),
    chat: sqliteChat(db),
    config: sqliteConfig(db),
    kv: sqliteKv(db),
    audit: sqliteAudit(db),
    externalAccounts: sqliteExternalAccounts(db),
    libraries: sqliteLibraries(db),
    slackMessages: sqliteSlackMessages(db),
    database: sqliteDatabase(db),
    async close() {
      db.close()
    },
  }
}

interface JobRow {
  id: string
  analyzer: string
  repo_forge: string
  repo_path: string
  group_name: string | null
  ref: string | null
  options: string
  trigger: Job['trigger']
  status: Job['status']
  attempts: number
  max_attempts: number
  run_after: string
  created_at: string
  started_at: string | null
  finished_at: string | null
  worker_id: string | null
  heartbeat_at: string | null
  error: string | null
  analysis_id: string | null
  error_signature: string | null
  attempts_history: string
  actor: string | null
  schedule: string | null
  reason: string | null
}

const toJob = (r: JobRow): Job => ({
  id: r.id,
  analyzer: r.analyzer,
  repo: { forge: r.repo_forge, path: r.repo_path },
  ...(r.group_name !== null && { group: r.group_name }),
  ...(r.ref !== null && { ref: r.ref }),
  options: JSON.parse(r.options),
  trigger: r.trigger,
  status: r.status,
  attempts: r.attempts,
  maxAttempts: r.max_attempts,
  runAfter: r.run_after,
  createdAt: r.created_at,
  ...(r.started_at !== null && { startedAt: r.started_at }),
  ...(r.finished_at !== null && { finishedAt: r.finished_at }),
  ...(r.worker_id !== null && { workerId: r.worker_id }),
  ...(r.heartbeat_at !== null && { heartbeatAt: r.heartbeat_at }),
  ...(r.error !== null && { error: r.error }),
  ...(r.error_signature !== null && { errorSignature: r.error_signature }),
  attemptsHistory: JSON.parse(r.attempts_history),
  ...(r.analysis_id !== null && { analysisId: r.analysis_id }),
  ...(r.actor !== null && { actor: r.actor }),
  ...(r.schedule !== null && { schedule: r.schedule }),
  ...(r.reason !== null && { reason: r.reason }),
})

/** `attempts_history` with the patch in parameter `param` (a JSON object) merged into its running last attempt. */
const endAttempt = (param: string) =>
  `CASE WHEN json_extract(attempts_history, '$[#-1].status') = 'running'
     THEN json_set(attempts_history, '$[#-1]', json_patch(json_extract(attempts_history, '$[#-1]'), ${param}))
     ELSE attempts_history END`

/** JSON of an attempt patch; absent fields are left out so they do not overwrite anything. */
const attemptPatch = (patch: Record<string, string | undefined>) =>
  JSON.stringify(Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)))

/** SQL condition and parameter limiting jobs to `repos` (none when omitted). */
const reposParam = (repos: { forge: string; path: string }[] | undefined) =>
  repos === undefined ? null : JSON.stringify(repos.map((repo) => [repo.forge, repo.path]))

const MATCHES_SEARCH = (text: string, analyzers: string) =>
  `(${text} IS NULL OR lower(id) LIKE ${text} || '%' ESCAPE '\\'
     OR lower(repo_path) LIKE '%' || ${text} || '%' ESCAPE '\\'
     OR lower(coalesce(group_name, '')) LIKE '%' || ${text} || '%' ESCAPE '\\'
     OR lower(analyzer) LIKE '%' || ${text} || '%' ESCAPE '\\'
     OR analyzer IN (SELECT value FROM json_each(${analyzers})))`

const IN_REPOS = (param: string) =>
  `(${param} IS NULL OR EXISTS (SELECT 1 FROM json_each(${param}) r
     WHERE json_extract(r.value, '$[0]') = repo_forge AND json_extract(r.value, '$[1]') = repo_path))`

const searchParams = (search: JobSearch | undefined): [string | null, string] => [
  search ? likeText(search.text) : null,
  json(search?.analyzers ?? []),
]

interface FailureRow {
  analyzer: string
  error_signature: string
  count: number
  repos: number
  first_at: string
  last_at: string
  id: string
  error: string | null
}

function sqliteJobs(db: Database): JobStore {
  const sql = {
    insert: db.query<
      JobRow,
      [
        string,
        string,
        string,
        string,
        string | null,
        string | null,
        string,
        string,
        number,
        string,
        string,
        string | null,
        string | null,
        string | null,
      ]
    >(
      `INSERT INTO jobs (id, analyzer, repo_forge, repo_path, group_name, ref, options, trigger, status, attempts,
         max_attempts, run_after, created_at, actor, schedule, reason)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'queued', 0, ?9, ?10, ?11, ?12, ?13, ?14)
       RETURNING *`,
    ),
    // One statement, so picking and taking the job is atomic even across processes.
    claim: db.query<JobRow, [string, string, string, string, string, string | null, string]>(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, worker_id = ?1, started_at = ?2,
         heartbeat_at = ?2, finished_at = NULL,
         attempts_history = json_insert(attempts_history, '$[#]',
           json_object('n', attempts + 1, 'status', 'running', 'startedAt', ?2, 'workerId', ?1))
       WHERE id = (
         SELECT j.id FROM jobs j
         WHERE j.status = 'queued' AND j.run_after <= ?5
           AND (?6 IS NULL OR j.analyzer IN (SELECT value FROM json_each(?6)))
           AND j.analyzer NOT IN (SELECT value FROM json_each(?7))
           AND NOT EXISTS (
             SELECT 1 FROM jobs r
             WHERE r.status = 'running' AND r.repo_forge = j.repo_forge AND r.repo_path = j.repo_path
               AND (r.analyzer = j.analyzer OR j.analyzer IN (SELECT value FROM json_each(?3)))
           )
           AND NOT EXISTS (
             SELECT 1 FROM jobs d
             WHERE d.repo_forge = j.repo_forge AND d.repo_path = j.repo_path
               AND (d.analyzer IN (SELECT value FROM json_each(?3))
                 OR d.analyzer IN (SELECT value FROM json_each(?4, '$.' || json_quote(j.analyzer))))
               AND (d.status = 'running'
                 OR (d.status = 'queued' AND (d.run_after < j.run_after
                   OR (d.run_after = j.run_after AND d.seq < j.seq))))
           )
         ORDER BY j.run_after, j.seq LIMIT 1
       )
       RETURNING *`,
    ),
    heartbeat: db.query<{ id: string }, [string, string, string]>(
      `UPDATE jobs SET heartbeat_at = ?3 WHERE id = ?1 AND worker_id = ?2 AND status = 'running'
       RETURNING id`,
    ),
    complete: db.query<JobRow, [string, string, string | null, string]>(
      `UPDATE jobs SET status = 'succeeded', finished_at = ?2, error = NULL, error_signature = NULL,
         analysis_id = COALESCE(?3, analysis_id), attempts_history = ${endAttempt('?4')}
       WHERE id = ?1 AND status = 'running'
       RETURNING *`,
    ),
    fail: db.query<JobRow, [string, string, string, string | null, string, string]>(
      `UPDATE jobs SET error = ?3, error_signature = ?5, attempts_history = ${endAttempt('?6')},
         status = CASE WHEN ?4 IS NOT NULL AND attempts < max_attempts THEN 'queued' ELSE 'failed' END,
         run_after = CASE WHEN ?4 IS NOT NULL AND attempts < max_attempts THEN ?4 ELSE run_after END,
         worker_id = CASE WHEN ?4 IS NOT NULL AND attempts < max_attempts THEN NULL ELSE worker_id END,
         finished_at = CASE WHEN ?4 IS NOT NULL AND attempts < max_attempts THEN finished_at ELSE ?2 END
       WHERE id = ?1 AND status = 'running'
       RETURNING *`,
    ),
    block: db.query<JobRow, [string, string, string, string]>(
      `UPDATE jobs SET status = 'blocked', finished_at = ?2, error = ?3, error_signature = NULL,
         attempts_history = ${endAttempt('?4')}
       WHERE id = ?1 AND status = 'running'
       RETURNING *`,
    ),
    cancel: db.query<JobRow, [string, string, string]>(
      `UPDATE jobs SET status = 'canceled', finished_at = ?2, attempts_history = ${endAttempt('?3')}
       WHERE id = ?1 AND status IN ('queued', 'running')
       RETURNING *`,
    ),
    recover: db.query<JobRow, [string, string, string, string, string]>(
      `UPDATE jobs SET error = ?3, error_signature = ?4, attempts_history = ${endAttempt('?5')},
         status = CASE WHEN attempts < max_attempts THEN 'queued' ELSE 'failed' END,
         run_after = CASE WHEN attempts < max_attempts THEN ?2 ELSE run_after END,
         worker_id = CASE WHEN attempts < max_attempts THEN NULL ELSE worker_id END,
         finished_at = CASE WHEN attempts < max_attempts THEN finished_at ELSE ?2 END
       WHERE status = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < ?1)
       RETURNING *`,
    ),
    get: db.query<JobRow, [string]>('SELECT * FROM jobs WHERE id = ?'),
    list: db.query<
      JobRow,
      [
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        number,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string,
      ]
    >(
      `SELECT * FROM jobs
       WHERE (?1 IS NULL OR status IN (SELECT value FROM json_each(?1)))
         AND (?2 IS NULL OR (repo_forge = ?2 AND repo_path = ?3))
         AND (?4 IS NULL OR analyzer = ?4)
         AND (?5 IS NULL OR created_at < ?5)
         AND (?7 IS NULL OR schedule = ?7)
         AND (?8 IS NULL OR error_signature = ?8)
         AND ${IN_REPOS('?9')}
         AND (?10 IS NULL OR trigger = ?10)
         AND (?11 IS NULL OR analysis_id = ?11)
         AND ${MATCHES_SEARCH('?12', '?13')}
       ORDER BY created_at DESC, seq DESC LIMIT ?6`,
    ),
    count: db.query<
      { status: JobStatus; count: number },
      [
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string,
      ]
    >(
      `SELECT status, count(*) AS count FROM jobs
       WHERE (?1 IS NULL OR status IN (SELECT value FROM json_each(?1)))
         AND (?2 IS NULL OR (repo_forge = ?2 AND repo_path = ?3))
         AND (?4 IS NULL OR analyzer = ?4)
         AND (?5 IS NULL OR created_at >= ?5)
         AND (?6 IS NULL OR schedule = ?6)
         AND (?7 IS NULL OR error_signature = ?7)
         AND ${IN_REPOS('?8')}
         AND (?9 IS NULL OR trigger = ?9)
         AND (?10 IS NULL OR analysis_id = ?10)
         AND ${MATCHES_SEARCH('?11', '?12')}
       GROUP BY status`,
    ),
    // SQLite takes the bare id and error from the row that holds max(finished_at).
    failures: db.query<FailureRow, [string, string | null, string | null, number]>(
      `SELECT analyzer, error_signature, count(*) AS count,
         count(DISTINCT repo_forge || ':' || repo_path) AS repos,
         min(finished_at) AS first_at, max(finished_at) AS last_at, id, error
       FROM jobs
       WHERE status = 'failed' AND error_signature IS NOT NULL AND finished_at >= ?1
         AND (?2 IS NULL OR analyzer = ?2) AND ${IN_REPOS('?3')}
       GROUP BY analyzer, error_signature
       ORDER BY last_at DESC LIMIT ?4`,
    ),
    targets: db.query<{ repo_forge: string; repo_path: string; group_name: string | null }, []>(
      'SELECT DISTINCT repo_forge, repo_path, group_name FROM jobs',
    ),
  }

  const one = (row: JobRow | null) => (row ? toJob(row) : undefined)

  return {
    async enqueue(job) {
      const row = sql.insert.get(
        crypto.randomUUID(),
        job.analyzer,
        job.repo.forge,
        job.repo.path,
        orNull(job.group),
        orNull(job.ref),
        json(job.options ?? {}),
        job.trigger,
        job.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        job.runAfter ?? job.createdAt,
        job.createdAt,
        orNull(job.actor),
        orNull(job.schedule),
        orNull(job.reason),
      )
      if (!row) throw new Error('job insert returned nothing')
      return toJob(row)
    },
    async claim(workerId, now, { exclusive = [], after = {}, delayMs, only, except = [] } = {}) {
      return one(
        sql.claim.get(
          workerId,
          now,
          JSON.stringify(exclusive),
          JSON.stringify(after),
          claimDueBy(now, delayMs),
          only ? JSON.stringify(only) : null,
          JSON.stringify(except),
        ),
      )
    },
    async heartbeat(id, workerId, now) {
      return sql.heartbeat.get(id, workerId, now) !== null
    },
    async complete(id, { at, analysisId }) {
      return one(
        sql.complete.get(
          id,
          at,
          orNull(analysisId),
          attemptPatch({ status: 'succeeded', finishedAt: at }),
        ),
      )
    },
    async fail(id, { at, error, retryAt, step }) {
      return one(
        sql.fail.get(
          id,
          at,
          error,
          orNull(retryAt),
          errorSignature(error),
          attemptPatch({ status: 'failed', finishedAt: at, error, step }),
        ),
      )
    },
    async block(id, { at, error }) {
      return one(
        sql.block.get(id, at, error, attemptPatch({ status: 'blocked', finishedAt: at, error })),
      )
    },
    async cancel(id, at) {
      return one(
        sql.cancel.get(id, at, attemptPatch({ status: 'canceled', finishedAt: at })) ??
          sql.get.get(id),
      )
    },
    async recoverStale(heartbeatBefore, at) {
      return sql.recover
        .all(
          heartbeatBefore,
          at,
          STALE_JOB_ERROR,
          errorSignature(STALE_JOB_ERROR),
          attemptPatch({
            status: 'failed',
            finishedAt: at,
            error: STALE_JOB_ERROR,
          }),
        )
        .map(toJob)
    },
    async get(id) {
      return one(sql.get.get(id))
    },
    async list(query = {}) {
      const { status, repo, analyzer, schedule, trigger, before, repos, limit = 50 } = query
      return sql.list
        .all(
          status === undefined ? null : json([status].flat()),
          orNull(repo?.forge),
          orNull(repo?.path),
          orNull(analyzer),
          orNull(before),
          limit,
          orNull(schedule),
          orNull(query.errorSignature),
          reposParam(repos),
          orNull(trigger),
          orNull(query.analysisId),
          ...searchParams(query.search),
        )
        .map(toJob)
    },
    async count(query = {}) {
      const { status, repo, analyzer, schedule, trigger, since, repos } = query
      return jobCounts(
        sql.count
          .all(
            status === undefined ? null : json([status].flat()),
            orNull(repo?.forge),
            orNull(repo?.path),
            orNull(analyzer),
            orNull(since),
            orNull(schedule),
            orNull(query.errorSignature),
            reposParam(repos),
            orNull(trigger),
            orNull(query.analysisId),
            ...searchParams(query.search),
          )
          .map((row) => [row.status, row.count] as const),
      )
    },
    async failures({ since, analyzer, repos, limit = 50 }) {
      return sql.failures.all(since, orNull(analyzer), reposParam(repos), limit).map((row) => ({
        analyzer: row.analyzer,
        errorSignature: row.error_signature,
        count: row.count,
        repos: row.repos,
        firstAt: row.first_at,
        lastAt: row.last_at,
        latestJobId: row.id,
        error: row.error ?? '',
      }))
    },
    async targets() {
      return sql.targets.all().map((row) => ({
        repo: { forge: row.repo_forge, path: row.repo_path },
        ...(row.group_name !== null && { group: row.group_name }),
      }))
    },
  }
}
