import type {
  ActivityEvent,
  AiUsageRecord,
  AnalysisRecord,
  AuditRun,
  Identity,
  Job,
  ExternalAccount,
  KnowledgeContent,
  KnowledgeEntry,
  KnowledgeRevision,
  LinkToken,
  Passkey,
  SettingEntry,
  StoredCredential,
  User,
} from '@holtkeeper/store'

/** A `timestamptz` value as Bun returns it (a `Date`), or a string from a text cast. */
export type PgTimestamp = Date | string

/** Normalizes a `timestamptz` value to the contract's ISO 8601 form, `2026-10-29T12:00:00.000Z`. */
export function iso(value: PgTimestamp): string {
  return (typeof value === 'string' ? new Date(value) : value).toISOString()
}

const isoOr = (value: PgTimestamp | null) => (value === null ? undefined : iso(value))

/** Postgres `int8` and `numeric` arrive as strings; counters and sums are plain numbers here. */
export const num = (value: number | string | null | undefined): number => Number(value ?? 0)

export interface AuditRunRow {
  id: string
  repo_forge: string
  repo_path: string
  trigger: AuditRun['trigger']
  actor: string | null
  started_at: PgTimestamp
  finished_at: PgTimestamp
  report: AuditRun['report']
}

export const toAuditRun = (r: AuditRunRow): AuditRun => ({
  id: r.id,
  repo: { forge: r.repo_forge, path: r.repo_path },
  trigger: r.trigger,
  ...(r.actor !== null && { actor: r.actor }),
  startedAt: iso(r.started_at),
  finishedAt: iso(r.finished_at),
  report: r.report,
})

export interface AnalysisRow {
  id: string
  repo_forge: string
  repo_path: string
  kind: string
  ref: string | null
  created_at: PgTimestamp
  actor: string | null
  data: unknown
}

export const toAnalysis = (r: AnalysisRow): AnalysisRecord => ({
  id: r.id,
  repo: { forge: r.repo_forge, path: r.repo_path },
  kind: r.kind,
  ...(r.ref !== null && { ref: r.ref }),
  createdAt: iso(r.created_at),
  ...(r.actor !== null && { actor: r.actor }),
  data: r.data,
})

export interface CredentialRow {
  id: string
  name: string
  kind: string
  url: string
  scope: StoredCredential['scope']
  secret: string
  expires_at: PgTimestamp | null
  rotation: StoredCredential['rotation'] | null
  last_rotated_at: PgTimestamp | null
  last_error: string | null
  options: Record<string, unknown> | null
  created_at: PgTimestamp
  updated_at: PgTimestamp
}

export const toCredential = (r: CredentialRow): StoredCredential => {
  const expiresAt = isoOr(r.expires_at)
  const lastRotatedAt = isoOr(r.last_rotated_at)
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    url: r.url,
    scope: r.scope,
    secret: r.secret,
    ...(expiresAt !== undefined && { expiresAt }),
    ...(r.rotation !== null && r.rotation !== undefined && { rotation: r.rotation }),
    ...(lastRotatedAt !== undefined && { lastRotatedAt }),
    ...(r.last_error !== null && { lastError: r.last_error }),
    ...(r.options !== null && { options: r.options }),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  }
}

export interface SettingRow {
  id: string
  key: string
  scope: SettingEntry['scope']
  value: unknown
  secret: boolean
  updated_at: PgTimestamp
  updated_by: string | null
}

export const toSetting = (r: SettingRow): SettingEntry => ({
  id: r.id,
  key: r.key,
  scope: r.scope,
  value: r.value,
  secret: r.secret,
  updatedAt: iso(r.updated_at),
  ...(r.updated_by !== null && { updatedBy: r.updated_by }),
})

export interface UserRow {
  id: string
  name: string
  email: string | null
  grants: User['grants']
  disabled: boolean
  session_version: number
  created_at: PgTimestamp
  created_by: string | null
  avatar_seed: string | null
}

export const toUser = (r: UserRow): User => ({
  id: r.id,
  name: r.name,
  ...(r.email !== null && { email: r.email }),
  grants: r.grants,
  disabled: r.disabled,
  sessionVersion: num(r.session_version),
  createdAt: iso(r.created_at),
  ...(r.created_by !== null && { createdBy: r.created_by }),
  ...(r.avatar_seed !== null && r.avatar_seed !== undefined && { avatarSeed: r.avatar_seed }),
})

/** Passkey and link token times are text: they are stored exactly as given. */
export interface PasskeyRow {
  id: string
  user_id: string
  public_key: string
  counter: number | string
  transports: string[] | null
  label: string | null
  created_at: string
  last_used_at: string | null
}

export const toPasskey = (r: PasskeyRow): Passkey => ({
  id: r.id,
  userId: r.user_id,
  publicKey: r.public_key,
  counter: num(r.counter),
  ...(r.transports !== null && { transports: r.transports }),
  ...(r.label !== null && { label: r.label }),
  createdAt: r.created_at,
  ...(r.last_used_at !== null && { lastUsedAt: r.last_used_at }),
})

export interface IdentityRow {
  provider: string
  subject: string
  user_id: string
  email: string | null
}

export const toIdentity = (r: IdentityRow): Identity => ({
  provider: r.provider,
  subject: r.subject,
  userId: r.user_id,
  ...(r.email !== null && { email: r.email }),
})

export interface LinkTokenRow {
  token_hash: string
  user_id: string
  purpose: LinkToken['purpose']
  expires_at: string
  used_at: string | null
  created_by: string | null
}

export const toLinkToken = (r: LinkTokenRow): LinkToken => ({
  tokenHash: r.token_hash,
  userId: r.user_id,
  purpose: r.purpose,
  expiresAt: r.expires_at,
  ...(r.used_at !== null && { usedAt: r.used_at }),
  ...(r.created_by !== null && { createdBy: r.created_by }),
})

export interface ActivityRow {
  id: string
  at: PgTimestamp
  actor: string
  action: string
  subject: string | null
  details: Record<string, unknown> | null
}

export const toActivity = (r: ActivityRow): ActivityEvent => ({
  id: r.id,
  at: iso(r.at),
  actor: r.actor,
  action: r.action,
  ...(r.subject !== null && { subject: r.subject }),
  ...(r.details !== null && { details: r.details }),
})

export interface JobRow {
  id: string
  analyzer: string
  repo_forge: string
  repo_path: string
  group_name: string | null
  ref: string | null
  options: Record<string, unknown>
  trigger: Job['trigger']
  status: Job['status']
  attempts: number
  max_attempts: number
  run_after: PgTimestamp
  created_at: PgTimestamp
  started_at: PgTimestamp | null
  finished_at: PgTimestamp | null
  worker_id: string | null
  heartbeat_at: PgTimestamp | null
  error: string | null
  analysis_id: string | null
  log: string[]
  actor: string | null
  schedule: string | null
}

export const toJob = (r: JobRow): Job => {
  const startedAt = isoOr(r.started_at)
  const finishedAt = isoOr(r.finished_at)
  const heartbeatAt = isoOr(r.heartbeat_at)
  return {
    id: r.id,
    analyzer: r.analyzer,
    repo: { forge: r.repo_forge, path: r.repo_path },
    ...(r.group_name !== null && { group: r.group_name }),
    ...(r.ref !== null && { ref: r.ref }),
    options: r.options,
    trigger: r.trigger,
    status: r.status,
    attempts: num(r.attempts),
    maxAttempts: num(r.max_attempts),
    runAfter: iso(r.run_after),
    createdAt: iso(r.created_at),
    ...(startedAt !== undefined && { startedAt }),
    ...(finishedAt !== undefined && { finishedAt }),
    ...(r.worker_id !== null && { workerId: r.worker_id }),
    ...(heartbeatAt !== undefined && { heartbeatAt }),
    ...(r.error !== null && { error: r.error }),
    ...(r.analysis_id !== null && { analysisId: r.analysis_id }),
    log: r.log,
    ...(r.actor !== null && { actor: r.actor }),
    ...(r.schedule !== null && { schedule: r.schedule }),
  }
}

export interface KnowledgeRow {
  id: string
  title: string
  body: string
  kind: KnowledgeEntry['kind']
  status: KnowledgeEntry['status']
  source: KnowledgeEntry['source']
  author: string
  scope: KnowledgeEntry['scope']
  topics: string[]
  applies_to: string[]
  packages: KnowledgeEntry['packages'] | null
  evidence: KnowledgeEntry['evidence']
  supersedes: string | null
  created_at: PgTimestamp
  updated_at: PgTimestamp
  updated_by: string | null
  version: number
}

export const toKnowledgeEntry = (r: KnowledgeRow): KnowledgeEntry => ({
  id: r.id,
  title: r.title,
  body: r.body,
  kind: r.kind,
  scope: r.scope,
  topics: r.topics,
  appliesTo: r.applies_to,
  ...(r.packages !== null && r.packages !== undefined && { packages: r.packages }),
  status: r.status,
  evidence: r.evidence,
  ...(r.supersedes !== null && { supersedes: r.supersedes }),
  source: r.source,
  author: r.author,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
  ...(r.updated_by !== null && { updatedBy: r.updated_by }),
  version: num(r.version),
})

/** The versioned part of an entry, as stored in `knowledge_history.content`. */
export const knowledgeContent = (entry: KnowledgeEntry): KnowledgeContent => ({
  title: entry.title,
  body: entry.body,
  kind: entry.kind,
  scope: entry.scope,
  topics: entry.topics,
  appliesTo: entry.appliesTo,
  ...(entry.packages !== undefined && { packages: entry.packages }),
  status: entry.status,
  evidence: entry.evidence,
  ...(entry.supersedes !== undefined && { supersedes: entry.supersedes }),
})

export interface KnowledgeHistoryRow {
  version: number
  content: KnowledgeContent
  edited_by: string
  edited_at: PgTimestamp
}

export const toKnowledgeRevision = (r: KnowledgeHistoryRow): KnowledgeRevision => ({
  ...r.content,
  version: num(r.version),
  editedBy: r.edited_by,
  editedAt: iso(r.edited_at),
})

export interface AiUsageRow {
  id: string
  at: PgTimestamp
  repo_forge: string
  repo_path: string
  groups: string[]
  task_kind: string
  analyzer: string | null
  job_id: string | null
  analysis_id: string | null
  actor: string
  provider: string
  model: string
  input_tokens: number | string
  output_tokens: number | string
  cache_read_tokens: number | string
  cache_write_tokens: number | string
  cost_usd: number
  cost_source: AiUsageRecord['costSource']
  duration_ms: number | string
  turns: number
  outcome: AiUsageRecord['outcome']
  error: string | null
}

export const toAiUsage = (r: AiUsageRow): AiUsageRecord => ({
  id: r.id,
  at: iso(r.at),
  repo: { forge: r.repo_forge, path: r.repo_path },
  groups: r.groups,
  taskKind: r.task_kind,
  ...(r.analyzer !== null && { analyzer: r.analyzer }),
  ...(r.job_id !== null && { jobId: r.job_id }),
  ...(r.analysis_id !== null && { analysisId: r.analysis_id }),
  actor: r.actor,
  provider: r.provider,
  model: r.model,
  inputTokens: num(r.input_tokens),
  outputTokens: num(r.output_tokens),
  cacheReadTokens: num(r.cache_read_tokens),
  cacheWriteTokens: num(r.cache_write_tokens),
  costUsd: num(r.cost_usd),
  costSource: r.cost_source,
  durationMs: num(r.duration_ms),
  turns: num(r.turns),
  outcome: r.outcome,
  ...(r.error !== null && { error: r.error }),
})

export interface ExternalAccountRow {
  id: string
  user_id: string
  provider: string
  external_id: string
  username: string | null
  verification: ExternalAccount['verification']
  linked_by: string
  linked_at: PgTimestamp
  verified_at: PgTimestamp | null
  challenge: ExternalAccount['challenge'] | null
  principal: ExternalAccount['principal'] | null
}

export const toExternalAccount = (r: ExternalAccountRow): ExternalAccount => {
  const verifiedAt = isoOr(r.verified_at)
  return {
    id: r.id,
    userId: r.user_id,
    provider: r.provider,
    externalId: r.external_id,
    ...(r.username !== null && { username: r.username }),
    verification: r.verification,
    linkedBy: r.linked_by,
    linkedAt: iso(r.linked_at),
    ...(verifiedAt !== undefined && { verifiedAt }),
    ...(r.challenge !== null && r.challenge !== undefined && { challenge: r.challenge }),
    ...(r.principal !== null && r.principal !== undefined && { principal: r.principal }),
  }
}
