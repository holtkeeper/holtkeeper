import { Database } from 'bun:sqlite'

import type {
  ActivityEvent,
  AnalysisRecord,
  AuditRun,
  Identity,
  Job,
  JobStore,
  LinkToken,
  Passkey,
  SettingEntry,
  Store,
  StoredCredential,
  User,
} from '@holtkeeper/store'
import { DEFAULT_MAX_ATTEMPTS, JOB_LOG_LIMIT } from '@holtkeeper/store'

import { sqliteExternalAccounts } from './accounts.ts'
import { sqliteAiUsage } from './ai-usage.ts'
import { sqliteAudit } from './audit.ts'
import { sqliteConfig, sqliteKv } from './config.ts'
import { sqliteKnowledge } from './knowledge.ts'
import { migrate } from './migrations.ts'

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
  created_at: string
  actor: string | null
  data: string
}

const toAnalysis = (r: AnalysisRow): AnalysisRecord => ({
  id: r.id,
  repo: { forge: r.repo_forge, path: r.repo_path },
  kind: r.kind,
  ...(r.ref !== null && { ref: r.ref }),
  createdAt: r.created_at,
  ...(r.actor !== null && { actor: r.actor }),
  data: JSON.parse(r.data),
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

interface ActivityRow {
  id: string
  at: string
  actor: string
  action: string
  subject: string | null
  details: string | null
}

const toActivity = (r: ActivityRow): ActivityEvent => ({
  id: r.id,
  at: r.at,
  actor: r.actor,
  action: r.action,
  ...(r.subject !== null && { subject: r.subject }),
  ...(r.details !== null && { details: JSON.parse(r.details) }),
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
      `INSERT INTO analyses (id, repo_forge, repo_path, kind, ref, created_at, actor, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    analysisGet: db.query<AnalysisRow, [string]>('SELECT * FROM analyses WHERE id = ?'),
    analysisList: db.query<
      AnalysisRow,
      [string | null, string | null, string | null, string | null, number]
    >(
      `SELECT * FROM analyses
       WHERE (?1 IS NULL OR (repo_forge = ?1 AND repo_path = ?2)) AND (?3 IS NULL OR kind = ?3)
         AND (?4 IS NULL OR created_at < ?4)
       ORDER BY created_at DESC, seq DESC LIMIT ?5`,
    ),
    credList: db.query<CredentialRow, []>('SELECT * FROM credentials ORDER BY seq'),
    credGet: db.query<CredentialRow, [string]>('SELECT * FROM credentials WHERE id = ?'),
    credPut: db.prepare(
      `INSERT INTO credentials (id, name, kind, url, scope, secret, expires_at, rotation, last_rotated_at, last_error, options, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, kind = excluded.kind, url = excluded.url, scope = excluded.scope,
         secret = excluded.secret, expires_at = excluded.expires_at, rotation = excluded.rotation,
         last_rotated_at = excluded.last_rotated_at, last_error = excluded.last_error, options = excluded.options,
         created_at = excluded.created_at, updated_at = excluded.updated_at`,
    ),
    credRemove: db.prepare('DELETE FROM credentials WHERE id = ?'),
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
      `INSERT INTO users (id, name, email, email_lower, grants, disabled, session_version, created_at, created_by, avatar_seed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, email = excluded.email, email_lower = excluded.email_lower,
         grants = excluded.grants, disabled = excluded.disabled, session_version = excluded.session_version,
         created_at = excluded.created_at, created_by = excluded.created_by, avatar_seed = excluded.avatar_seed`,
    ),
    userRemove: db.prepare('DELETE FROM users WHERE id = ?'),
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
    activityInsert: db.prepare(
      'INSERT INTO activity (id, at, actor, action, subject, details) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    activityList: db.query<ActivityRow, [string | null, number]>(
      'SELECT * FROM activity WHERE (?1 IS NULL OR at < ?1) ORDER BY at DESC, seq DESC LIMIT ?2',
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
          record.createdAt,
          orNull(record.actor),
          json(record.data),
        )
        return stored
      },
      async get(id) {
        const row = sql.analysisGet.get(id)
        return row ? toAnalysis(row) : undefined
      },
      async list({ repo, kind, before, limit = 50 } = {}) {
        return sql.analysisList
          .all(orNull(repo?.forge), orNull(repo?.path), orNull(kind), orNull(before), limit)
          .map(toAnalysis)
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
          c.createdAt,
          c.updatedAt,
        )
      },
      async remove(id) {
        sql.credRemove.run(id)
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
        )
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
    activity: {
      async append(event) {
        const stored: ActivityEvent = { ...event, id: crypto.randomUUID() }
        sql.activityInsert.run(
          stored.id,
          event.at,
          event.actor,
          event.action,
          orNull(event.subject),
          event.details ? json(event.details) : null,
        )
        return stored
      },
      async list({ before, limit = 50 } = {}) {
        return sql.activityList.all(orNull(before), limit).map(toActivity)
      },
    },
    jobs: sqliteJobs(db),
    knowledge: sqliteKnowledge(db),
    aiUsage: sqliteAiUsage(db),
    config: sqliteConfig(db),
    kv: sqliteKv(db),
    audit: sqliteAudit(db),
    externalAccounts: sqliteExternalAccounts(db),
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
  log: string
  actor: string | null
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
  ...(r.analysis_id !== null && { analysisId: r.analysis_id }),
  log: JSON.parse(r.log),
  ...(r.actor !== null && { actor: r.actor }),
})

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
      ]
    >(
      `INSERT INTO jobs (id, analyzer, repo_forge, repo_path, group_name, ref, options, trigger, status, attempts,
         max_attempts, run_after, created_at, log, actor)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'queued', 0, ?9, ?10, ?11, '[]', ?12)
       RETURNING *`,
    ),
    // One statement, so picking and taking the job is atomic even across processes.
    claim: db.query<JobRow, [string, string]>(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, worker_id = ?1, started_at = ?2,
         heartbeat_at = ?2, finished_at = NULL
       WHERE id = (
         SELECT j.id FROM jobs j
         WHERE j.status = 'queued' AND j.run_after <= ?2
           AND NOT EXISTS (
             SELECT 1 FROM jobs r
             WHERE r.status = 'running' AND r.repo_forge = j.repo_forge AND r.repo_path = j.repo_path
           )
         ORDER BY j.run_after, j.seq LIMIT 1
       )
       RETURNING *`,
    ),
    heartbeat: db.query<{ id: string }, [string, string, string]>(
      `UPDATE jobs SET heartbeat_at = ?3 WHERE id = ?1 AND worker_id = ?2 AND status = 'running'
       RETURNING id`,
    ),
    complete: db.query<JobRow, [string, string, string | null]>(
      `UPDATE jobs SET status = 'succeeded', finished_at = ?2, error = NULL,
         analysis_id = COALESCE(?3, analysis_id)
       WHERE id = ?1 AND status = 'running'
       RETURNING *`,
    ),
    fail: db.query<JobRow, [string, string, string, string | null]>(
      `UPDATE jobs SET error = ?3,
         status = CASE WHEN ?4 IS NOT NULL AND attempts < max_attempts THEN 'queued' ELSE 'failed' END,
         run_after = CASE WHEN ?4 IS NOT NULL AND attempts < max_attempts THEN ?4 ELSE run_after END,
         worker_id = CASE WHEN ?4 IS NOT NULL AND attempts < max_attempts THEN NULL ELSE worker_id END,
         finished_at = CASE WHEN ?4 IS NOT NULL AND attempts < max_attempts THEN finished_at ELSE ?2 END
       WHERE id = ?1 AND status = 'running'
       RETURNING *`,
    ),
    cancel: db.query<JobRow, [string, string]>(
      `UPDATE jobs SET status = 'canceled', finished_at = ?2
       WHERE id = ?1 AND status IN ('queued', 'running')
       RETURNING *`,
    ),
    recover: db.query<JobRow, [string, string]>(
      `UPDATE jobs SET error = 'worker stopped responding',
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
      [string | null, string | null, string | null, string | null, string | null, number]
    >(
      `SELECT * FROM jobs
       WHERE (?1 IS NULL OR status IN (SELECT value FROM json_each(?1)))
         AND (?2 IS NULL OR (repo_forge = ?2 AND repo_path = ?3))
         AND (?4 IS NULL OR analyzer = ?4)
         AND (?5 IS NULL OR created_at < ?5)
       ORDER BY created_at DESC, seq DESC LIMIT ?6`,
    ),
    log: db.query<{ log: string }, [string]>('SELECT log FROM jobs WHERE id = ?'),
    setLog: db.prepare('UPDATE jobs SET log = ?2 WHERE id = ?1'),
  }

  const one = (row: JobRow | null) => (row ? toJob(row) : undefined)
  const appendLog = db.transaction((id: string, lines: string[]) => {
    const row = sql.log.get(id)
    if (!row) return
    const previous: unknown = JSON.parse(row.log)
    const log = [...(Array.isArray(previous) ? previous.map(String) : []), ...lines].slice(
      -JOB_LOG_LIMIT,
    )
    sql.setLog.run(id, json(log))
  })

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
      )
      if (!row) throw new Error('job insert returned nothing')
      return toJob(row)
    },
    async claim(workerId, now) {
      return one(sql.claim.get(workerId, now))
    },
    async heartbeat(id, workerId, now) {
      return sql.heartbeat.get(id, workerId, now) !== null
    },
    async complete(id, { at, analysisId }) {
      return one(sql.complete.get(id, at, orNull(analysisId)))
    },
    async fail(id, { at, error, retryAt }) {
      return one(sql.fail.get(id, at, error, orNull(retryAt)))
    },
    async cancel(id, at) {
      return one(sql.cancel.get(id, at) ?? sql.get.get(id))
    },
    async recoverStale(heartbeatBefore, at) {
      return sql.recover.all(heartbeatBefore, at).map(toJob)
    },
    async get(id) {
      return one(sql.get.get(id))
    },
    async list({ status, repo, analyzer, before, limit = 50 } = {}) {
      return sql.list
        .all(
          status === undefined ? null : json([status].flat()),
          orNull(repo?.forge),
          orNull(repo?.path),
          orNull(analyzer),
          orNull(before),
          limit,
        )
        .map(toJob)
    },
    async appendLog(id, lines) {
      appendLog(id, lines)
    },
  }
}
