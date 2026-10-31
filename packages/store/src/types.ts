import type { Grant, GroupMatch, Scope } from '@holtkeeper/access'
import type { RepoRef } from '@holtkeeper/forge'
import type { AuditReport } from '@holtkeeper/vuln'

/** ISO 8601 timestamp, e.g. `2026-10-29T12:00:00.000Z`. */
export type Timestamp = string

export type AuditTrigger = 'cli' | 'schedule' | 'manual' | 'webhook'

/** One finished audit of one repository. */
export interface AuditRun {
  id: string
  repo: RepoRef
  trigger: AuditTrigger
  /** Principal id that started the run, when a person did. */
  actor?: string
  startedAt: Timestamp
  finishedAt: Timestamp
  report: AuditReport
}

export interface AuditRunQuery {
  repo?: RepoRef
  /** Only runs that finished before this time; used for paging. */
  before?: Timestamp
  /** Default 50. */
  limit?: number
}

/** Audit runs, newest first. */
export interface AuditRunStore {
  add(run: Omit<AuditRun, 'id'>): Promise<AuditRun>
  get(id: string): Promise<AuditRun | undefined>
  list(query?: AuditRunQuery): Promise<AuditRun[]>
}

export interface RotationPolicy {
  enabled: boolean
  /** Rotate when the token expires within this many days. */
  daysBefore: number
  /** Lifetime requested for a new token. */
  lifetimeDays: number
}

/** A forge account or API key. `secret` is always sealed by a `Vault`. */
export interface StoredCredential {
  id: string
  name: string
  /** Who issued it and how it rotates: `gitlab`, `github`, `anthropic`, ... */
  kind: string
  /** Base URL of the service, e.g. `https://gitlab.example.com`. */
  url: string
  /** Which repositories may use it. */
  scope: Scope
  secret: string
  expiresAt?: Timestamp
  rotation?: RotationPolicy
  lastRotatedAt?: Timestamp
  /** Last rotation failure; cleared by a successful rotation. */
  lastError?: string
  /**
   * Kind-specific configuration that is not secret, e.g. an AI provider's endpoint, headers and
   * model map. Stored as given; the service that owns the kind validates it.
   */
  options?: Record<string, unknown>
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface CredentialStore {
  list(): Promise<StoredCredential[]>
  get(id: string): Promise<StoredCredential | undefined>
  /** Creates or replaces by id. */
  put(credential: StoredCredential): Promise<void>
  remove(id: string): Promise<void>
}

/**
 * A setting value for a scope. The same key may exist for several scopes; the most specific one
 * that covers a repository wins (see `@holtkeeper/settings`). Secret values are sealed strings.
 */
export interface SettingEntry {
  id: string
  key: string
  scope: Scope
  value: unknown
  secret: boolean
  updatedAt: Timestamp
  updatedBy?: string
}

export interface SettingStore {
  list(key?: string): Promise<SettingEntry[]>
  get(id: string): Promise<SettingEntry | undefined>
  put(entry: SettingEntry): Promise<void>
  remove(id: string): Promise<void>
}

export interface User {
  id: string
  name: string
  email?: string
  grants: Grant[]
  disabled: boolean
  /** Bumped to invalidate every session of the user. */
  sessionVersion: number
  createdAt: Timestamp
  createdBy?: string
  /** Seed of the generated avatar instead of the user id; set to reroll the avatar. */
  avatarSeed?: string
}

export interface Passkey {
  /** WebAuthn credential id, base64url. */
  id: string
  userId: string
  /** COSE public key, base64url. */
  publicKey: string
  counter: number
  transports?: string[]
  label?: string
  createdAt: Timestamp
  lastUsedAt?: Timestamp
}

/** Links an external identity (OIDC issuer + subject) to a user. */
export interface Identity {
  provider: string
  subject: string
  userId: string
  email?: string
}

/** A one-time link for enrolling a first passkey or recovering access. Only the hash is stored. */
export interface LinkToken {
  tokenHash: string
  userId: string
  purpose: 'enroll' | 'recover' | 'login'
  expiresAt: Timestamp
  usedAt?: Timestamp
  createdBy?: string
}

export interface UserStore {
  listUsers(): Promise<User[]>
  getUser(id: string): Promise<User | undefined>
  findUserByEmail(email: string): Promise<User | undefined>
  putUser(user: User): Promise<void>
  removeUser(id: string): Promise<void>

  listPasskeys(userId: string): Promise<Passkey[]>
  getPasskey(id: string): Promise<Passkey | undefined>
  putPasskey(passkey: Passkey): Promise<void>
  removePasskey(id: string): Promise<void>

  findIdentity(provider: string, subject: string): Promise<Identity | undefined>
  listIdentities(userId: string): Promise<Identity[]>
  putIdentity(identity: Identity): Promise<void>

  putLinkToken(token: LinkToken): Promise<void>
  getLinkToken(tokenHash: string): Promise<LinkToken | undefined>
}

/**
 * The stored result of an analysis (changelog, bundle sizes, dependency graph, ...). `data` is the
 * analysis kind's own shape; `@holtkeeper/report` turns it into a report.
 */
export interface AnalysisRecord<Data = unknown> {
  id: string
  repo: RepoRef
  kind: string
  /** Release, tag or commit the analysis describes, e.g. `v1.4.0`. */
  ref?: string
  createdAt: Timestamp
  actor?: string
  data: Data
}

export interface AnalysisQuery {
  repo?: RepoRef
  kind?: string
  /** Only records created before this time; used for paging and for finding the previous one. */
  before?: Timestamp
  /** Default 50. */
  limit?: number
}

/** Analysis records, newest first. */
export interface AnalysisStore {
  add(record: Omit<AnalysisRecord, 'id'>): Promise<AnalysisRecord>
  get(id: string): Promise<AnalysisRecord | undefined>
  list(query?: AnalysisQuery): Promise<AnalysisRecord[]>
}

/** Something a person or the system did, for the activity log. */
export interface ActivityEvent {
  id: string
  at: Timestamp
  actor: string
  /** Dotted verb, e.g. `credential.created`, `user.invited`, `audit.ingested`. */
  action: string
  /** Object the action was about, e.g. a credential id or `work:games/app-x`. */
  subject?: string
  details?: Record<string, unknown>
}

export interface ActivityStore {
  append(event: Omit<ActivityEvent, 'id'>): Promise<ActivityEvent>
  /** Newest first. */
  list(query?: { before?: Timestamp; limit?: number }): Promise<ActivityEvent[]>
}

export type JobTrigger = 'schedule' | 'manual' | 'webhook' | 'tag' | 'push' | 'poll'

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'

/**
 * One run of one analyzer for one repository, or for one config group when the analyzer has
 * group scope (then `repo` is `{ forge, path: <group name> }` and `group` is set).
 */
export interface Job {
  id: string
  /** Analyzer kind, e.g. `changelog`. */
  analyzer: string
  repo: RepoRef
  group?: string
  /** Release, tag or commit to analyze; the default branch when omitted. */
  ref?: string
  /** Raw analyzer options; the worker validates them with the analyzer's schema. */
  options: Record<string, unknown>
  trigger: JobTrigger
  status: JobStatus
  /** Runs started so far, including the current one. */
  attempts: number
  maxAttempts: number
  /** The job is not claimed before this time. */
  runAfter: Timestamp
  createdAt: Timestamp
  /** Start of the latest attempt. */
  startedAt?: Timestamp
  finishedAt?: Timestamp
  workerId?: string
  heartbeatAt?: Timestamp
  /** Error of the latest failed attempt. */
  error?: string
  /** The stored result, once the job succeeded. */
  analysisId?: string
  /** The last `JOB_LOG_LIMIT` log lines, oldest first. */
  log: string[]
  /** Principal id that requested the job, when a person did. */
  actor?: string
  /** Name of the schedule that queued the job, also for its manual runs. */
  schedule?: string
}

export interface NewJob {
  analyzer: string
  repo: RepoRef
  group?: string
  ref?: string
  options?: Record<string, unknown>
  trigger: JobTrigger
  /** Default 3. */
  maxAttempts?: number
  /** Default `createdAt`. */
  runAfter?: Timestamp
  createdAt: Timestamp
  actor?: string
  schedule?: string
}

export interface JobQuery {
  status?: JobStatus | JobStatus[]
  repo?: RepoRef
  analyzer?: string
  /** Only jobs queued by this schedule. */
  schedule?: string
  /** Only jobs created before this time; used for paging. */
  before?: Timestamp
  /** Default 50. */
  limit?: number
}

/** How jobs of one repository may run side by side, by analyzer kind; see `JobStore.claim`. */
export interface ClaimRules {
  /** Kinds whose jobs change their repository and so run alone on it. */
  exclusive?: string[]
  /**
   * Per kind, the kinds whose results its jobs read: a job waits while a job of one of these kinds
   * of its repository is running, or queued ahead of it in claim order.
   */
  after?: Record<string, string[]>
}

/**
 * The task queue. State changes are atomic: a job is claimed by at most one worker, and the
 * running jobs of a repository always satisfy the `ClaimRules` they were claimed under. Methods
 * that change a job return it as it is afterwards, or `undefined` when it does not exist or was
 * not in a state the change applies to.
 */
export interface JobStore {
  enqueue(job: NewJob): Promise<Job>
  /**
   * Takes the first queued job in `(runAfter, enqueue order)` with `runAfter <= now` that may start
   * next to the running jobs of its repository, marks it running for `workerId` and counts the
   * attempt. A job may start unless its repository runs a job of the same analyzer, the job is
   * exclusive and anything runs there, or an exclusive job or a job it comes `after` runs there or
   * is queued ahead of it, so readers neither overtake nor starve an exclusive job. Without `rules`
   * no kind is exclusive or ordered.
   */
  claim(workerId: string, now: Timestamp, rules?: ClaimRules): Promise<Job | undefined>
  /** Records that `workerId` still works on the job; `false` when it no longer runs it (canceled). */
  heartbeat(id: string, workerId: string, now: Timestamp): Promise<boolean>
  /** Marks a running job succeeded. */
  complete(id: string, result: { at: Timestamp; analysisId?: string }): Promise<Job | undefined>
  /**
   * Records a failed attempt of a running job. With `retryAt` and attempts left it goes back to
   * the queue to run after `retryAt`; otherwise it is failed for good.
   */
  fail(
    id: string,
    failure: { at: Timestamp; error: string; retryAt?: Timestamp },
  ): Promise<Job | undefined>
  /** Cancels a queued or running job; finished jobs are returned unchanged. */
  cancel(id: string, at: Timestamp): Promise<Job | undefined>
  /**
   * Running jobs whose last heartbeat is older than `heartbeatBefore` (their worker died) go back
   * to the queue, or fail when they used up their attempts. Returns the jobs it changed.
   */
  recoverStale(heartbeatBefore: Timestamp, at: Timestamp): Promise<Job[]>
  get(id: string): Promise<Job | undefined>
  /** Newest first. */
  list(query?: JobQuery): Promise<Job[]>
  /** Appends lines and keeps only the last `JOB_LOG_LIMIT`. */
  appendLog(id: string, lines: string[]): Promise<void>
}

export type KnowledgeKind = 'decision' | 'convention' | 'migration' | 'quirk' | 'howto'

export type KnowledgeStatus = 'proposed' | 'accepted' | 'rejected' | 'archived'

/**
 * A package a knowledge entry is about. `from` and `to` are semver ranges: the versions a
 * migration starts from and lands on. Absent ranges mean any version.
 */
export interface KnowledgePackage {
  /** `npm`, `go`, ... */
  ecosystem: string
  name: string
  from?: string
  to?: string
}

/** A link backing an entry up: a merge request, an issue, a discussion, a doc. */
export interface KnowledgeLink {
  label: string
  url: string
}

/** The editable content of a knowledge entry. */
export interface KnowledgeContent {
  title: string
  /** Markdown. */
  body: string
  kind: KnowledgeKind
  /** Which repositories the entry applies to. */
  scope: Scope
  /** Free tags, e.g. `testing`, `i18n`. */
  topics: string[]
  /** Task kinds the entry is relevant for (`review`, `port`, `propagate`, ...) or `*`. */
  appliesTo: string[]
  /** Required for `migration` entries. */
  packages?: KnowledgePackage[]
  status: KnowledgeStatus
  evidence: KnowledgeLink[]
  /** Id of the entry this one replaces. */
  supersedes?: string
}

/**
 * A decision, convention, migration note, quirk or how-to that agents read and propose and people
 * curate. `version` starts at 1 and grows by one with every `put`.
 */
export interface KnowledgeEntry extends KnowledgeContent {
  id: string
  source: 'human' | 'agent'
  /** Principal id (or agent actor) that created the entry. */
  author: string
  createdAt: Timestamp
  updatedAt: Timestamp
  /** Who made the current version; absent for the first version. */
  updatedBy?: string
  version: number
}

/** A previous version of an entry, with who made it and when. */
export interface KnowledgeRevision extends KnowledgeContent {
  version: number
  editedBy: string
  editedAt: Timestamp
}

/** What `KnowledgeStore.put` takes: the entry without the version the store assigns. */
export type KnowledgeEntryInput = Omit<KnowledgeEntry, 'version'>

/** Filters for `KnowledgeStore.list` and `search`. Every given field must match. */
export interface KnowledgeFilter {
  status?: KnowledgeStatus | KnowledgeStatus[]
  kind?: KnowledgeKind | KnowledgeKind[]
  /** Exact topic, case-insensitive. */
  topic?: string
  /**
   * Text matched case-insensitively as a substring of the scope's groups and repo patterns;
   * `all` also matches scopes covering everything.
   */
  scope?: string
  /** Package name, optionally with its ecosystem: `react` or `npm:react`. */
  package?: string
}

/** A search result; higher `score` is more relevant. */
export interface KnowledgeHit {
  entry: KnowledgeEntry
  score: number
}

/** The knowledge base. Entries keep every previous version. */
export interface KnowledgeStore {
  /**
   * Creates or replaces by id and returns the stored entry. Replacing keeps the previous version
   * in the history and bumps `version`.
   */
  put(entry: KnowledgeEntryInput): Promise<KnowledgeEntry>
  get(id: string): Promise<KnowledgeEntry | undefined>
  /** Previous versions, newest first; empty for unknown ids. */
  history(id: string): Promise<KnowledgeRevision[]>
  /** Most recently updated first. */
  list(filter?: KnowledgeFilter): Promise<KnowledgeEntry[]>
  /** Removes the entry and its history. */
  remove(id: string): Promise<void>
  /**
   * Entries matching any word of `text` (words are prefixes: `migr` finds `migration`), best
   * first. Title matches weigh more than topic matches, which weigh more than body matches. Any
   * text is safe: quotes, operators and punctuation are treated as plain words. Blank text
   * returns nothing. `limit` defaults to 20.
   */
  search(text: string, filter?: KnowledgeFilter, limit?: number): Promise<KnowledgeHit[]>
}

/** Where an AI run's `costUsd` came from: the provider's report, our price table, or nowhere. */
export type AiCostSource = 'reported' | 'computed' | 'unknown'

/** How an AI run ended. `denied-budget` runs never reached the model. */
export type AiRunOutcome = 'ok' | 'error' | 'denied-budget'

/** One LLM agent run with what it used and cost. Token counts are summed over every model call. */
export interface AiUsageRecord {
  id: string
  at: Timestamp
  repo: RepoRef
  /** Config groups of the repository at the time of the run; access and budgets use them. */
  groups: string[]
  /** `review`, `refactor`, `triage`, ... */
  taskKind: string
  /** Analyzer kind that started the run, when an analyzer did. */
  analyzer?: string
  jobId?: string
  analysisId?: string
  /** Principal id, or `system` / `agent:<name>` for unattended runs. */
  actor: string
  /** Credential id or name the run was billed to, or `anthropic`. */
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** 0 when `costSource` is `unknown`. */
  costUsd: number
  costSource: AiCostSource
  durationMs: number
  turns: number
  outcome: AiRunOutcome
  error?: string
}

/** Filters for AI usage. Every given field must match; `from` is inclusive, `to` exclusive. */
export interface AiUsageFilter {
  from?: Timestamp
  to?: Timestamp
  repo?: RepoRef
  /** Records whose `groups` contain this group. */
  group?: string
  model?: string
  provider?: string
  taskKind?: string
  analyzer?: string
  outcome?: AiRunOutcome
  /**
   * Records covered by at least one of these scopes (`scopeCoversRepo` with the record's repo and
   * groups). An empty list matches nothing; absent means no restriction.
   */
  scopes?: Scope[]
}

export interface AiUsageQuery extends AiUsageFilter {
  /** Only records before this time; used for paging. */
  before?: Timestamp
  /** Default 50. */
  limit?: number
}

/**
 * What aggregates can be split by. `day` is `YYYY-MM-DD`, `week` the Monday starting the ISO week
 * (`YYYY-MM-DD`), `month` `YYYY-MM`, all in UTC; `repo` is `forge:path`. Missing analyzers are `''`.
 * With `group` a record counts once in each of its groups, and records without groups under `''`.
 */
export type AiUsageDimension =
  | 'day'
  | 'week'
  | 'month'
  | 'repo'
  | 'group'
  | 'model'
  | 'provider'
  | 'taskKind'
  | 'analyzer'

/** Sums over a set of AI usage records. */
export interface AiUsageTotals {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
  /** Every record, denied ones included. */
  runs: number
  /** Records with outcome `error`. */
  errors: number
  /** Records with outcome `denied-budget`. */
  denied: number
  /** Mean duration of runs that were not denied; 0 when there are none. */
  avgDurationMs: number
}

/** One group of an aggregate: the dimension values it stands for and its sums. */
export interface AiUsageBucket extends AiUsageTotals {
  key: Partial<Record<AiUsageDimension, string>>
}

export interface AiUsageAggregateQuery {
  from?: Timestamp
  to?: Timestamp
  /** Empty or absent: one bucket over everything that matches. */
  groupBy?: AiUsageDimension[]
  filter?: AiUsageFilter
}

/** AI usage history. Append-only. */
export interface AiUsageStore {
  append(record: Omit<AiUsageRecord, 'id'>): Promise<AiUsageRecord>
  /** Newest first. */
  list(query?: AiUsageQuery): Promise<AiUsageRecord[]>
  /**
   * Sums per distinct combination of `groupBy` values, sorted by those values ascending in
   * `groupBy` order. No matching records, no buckets. `from`/`to` narrow `filter` further.
   */
  aggregate(query?: AiUsageAggregateQuery): Promise<AiUsageBucket[]>
}

/** A finished CI job attempt kept for job analytics. Durations are seconds. */
export interface CiJobRecord {
  repo: RepoRef
  /** The forge's job id; unique within the repository. */
  jobId: number
  pipelineId: number
  name: string
  stage: string
  status: 'success' | 'failed' | 'canceled'
  ref?: string
  sha?: string
  /** The pipeline ran for a tag; absent for branches and merge requests. */
  tag?: boolean
  createdAt: Timestamp
  startedAt?: Timestamp
  finishedAt?: Timestamp
  durationSeconds?: number
  queuedSeconds?: number
  allowFailure: boolean
  webUrl: string
}

/** Stored range of a repository's CI job history. */
export interface CiJobCoverage {
  oldest: Timestamp
  newest: Timestamp
  jobs: number
}

/**
 * CI job attempts per repository, so job analytics fetch only what is new. Times come back in
 * the contract's ISO 8601 form whatever form they were put in.
 */
export interface CiJobStore {
  /** Inserts records, replacing any with the same repository and job id. */
  put(records: CiJobRecord[]): Promise<void>
  /** Records of `repo` created in `[from, to)`, oldest first (ties by job id). */
  list(repo: RepoRef, range?: { from?: Timestamp; to?: Timestamp }): Promise<CiJobRecord[]>
  /** Creation times of the oldest and newest record of `repo`; undefined when there are none. */
  coverage(repo: RepoRef): Promise<CiJobCoverage | undefined>
  /** Removes records of every repository created before `before`; returns how many. */
  prune(before: Timestamp): Promise<number>
}

/** Kinds of configuration documents the panel manages. */
export type ConfigDocumentType = 'forge' | 'group' | 'repoTraits' | 'schedule' | 'trigger'

/** A webhook Holtkeeper registered on the forge for this forge document. */
export interface RegisteredWebhook {
  /** The forge's id of the hook. */
  hookId: string
  scope: 'group' | 'project'
  /** Group or project path the hook belongs to. */
  target: string
  url: string
}

/** The webhook of a managed forge: a generated secret and where it is registered. */
export interface ForgeWebhook {
  /** Sealed by a `Vault`; never returned by APIs. */
  secret: string
  createdAt: Timestamp
  registered?: RegisteredWebhook[]
}

/** The SSH key a managed forge issued for its token's account, kept as an `ssh` credential. */
export interface ForgeSshKey {
  credentialId: string
  createdAt: Timestamp
}

/** A forge managed in the panel. The token comes from the credential `credentialId`. */
export interface ForgeDocumentData {
  kind: 'gitlab' | 'github'
  url: string
  credentialId: string
  /** Jobs read this forge's package registries with its token, through the egress proxy. Default on. */
  packages?: boolean
  webhook?: ForgeWebhook
  sshKey?: ForgeSshKey
}

/** A group of repositories, as `groups.<id>` of the file config. */
export interface GroupDocumentData {
  forge: string
  include: string[]
  exclude: string[]
}

/** Traits for repositories matching `pattern`, as `repos.<pattern>` of the file config. */
export interface RepoTraitsDocumentData {
  pattern: string
  forge?: string
  traits: Record<string, string | number | boolean>
}

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'

/** Local time window on some days; `to` not after `from` runs past midnight. Times are `HH:MM`. */
export interface ScheduleWindow {
  days: Weekday[]
  from: string
  to: string
}

/** When a schedule may run; see `@holtkeeper/jobs` smart schedules. */
export interface ScheduleWindows {
  allow?: ScheduleWindow[]
  deny?: ScheduleWindow[]
  skipWeekends?: boolean
  skipNights?: { from: string; to: string }
  /** `YYYY-MM-DD` local dates. */
  holidays?: string[]
}

/** A schedule managed in the panel; the document id is the schedule's config `name`. */
export interface ScheduleDocumentData {
  /** Display name. */
  name: string
  enabled: boolean
  analyzers: string[]
  groups?: GroupMatch[]
  repos?: string[]
  options?: Record<string, Record<string, unknown>>
  cron?: string
  /** `15m`, `1h`, `6h`, `1d`, ... */
  every?: string
  timezone?: string
  windows?: ScheduleWindows
  jitterMinutes?: number
  spread?: boolean
}

/**
 * An event trigger managed in the panel. Document ids are fixed per entry: `tag`,
 * `merge-request`, `label:<label>` and `command:<name>`.
 */
export type TriggerDocumentData =
  | { on: 'tag'; analyzers: string[]; groups?: GroupMatch[] }
  | { on: 'push'; analyzers: string[]; branches?: string[]; groups?: GroupMatch[] }
  | {
      on: 'mergeRequest'
      analyzers: string[]
      actions?: ('open' | 'update' | 'reopen')[]
      draft?: boolean
      groups?: GroupMatch[]
    }
  | { on: 'label'; label: string; analyzers: string[] }
  | { on: 'command'; command: string; analyzer: string; args?: string[] }

/** The data shape of each configuration document type. */
export interface ConfigDocumentDataMap {
  forge: ForgeDocumentData
  group: GroupDocumentData
  repoTraits: RepoTraitsDocumentData
  schedule: ScheduleDocumentData
  trigger: TriggerDocumentData
}

/**
 * One configuration document. `(type, id)` is unique; `version` starts at 1 and grows by one with
 * every `put`.
 */
export interface ConfigDocument<T extends ConfigDocumentType = ConfigDocumentType> {
  type: T
  id: string
  data: ConfigDocumentDataMap[T]
  version: number
  updatedAt: Timestamp
  updatedBy?: string
}

/** A configuration document of any type, discriminated by `type`. */
export type AnyConfigDocument = { [T in ConfigDocumentType]: ConfigDocument<T> }[ConfigDocumentType]

/** What `ConfigStore.put` takes: the document without the version the store assigns. */
export type ConfigDocumentInput<T extends ConfigDocumentType = ConfigDocumentType> = Omit<
  ConfigDocument<T>,
  'version'
>

/** A previous version of a configuration document. */
export interface ConfigRevision<T extends ConfigDocumentType = ConfigDocumentType> {
  version: number
  data: ConfigDocumentDataMap[T]
  updatedAt: Timestamp
  updatedBy?: string
}

/** Configuration managed in the panel. Documents keep every previous version until removed. */
export interface ConfigStore {
  /** Creates or replaces by `(type, id)`; replacing keeps the previous version in the history. */
  put<T extends ConfigDocumentType>(input: ConfigDocumentInput<T>): Promise<ConfigDocument<T>>
  get<T extends ConfigDocumentType>(type: T, id: string): Promise<ConfigDocument<T> | undefined>
  /** Documents ordered by type, then id. */
  list<T extends ConfigDocumentType>(type: T): Promise<ConfigDocument<T>[]>
  list(): Promise<AnyConfigDocument[]>
  /** Previous versions, newest first; empty for unknown documents. */
  history<T extends ConfigDocumentType>(type: T, id: string): Promise<ConfigRevision<T>[]>
  /** Removes the document and its history. */
  remove(type: ConfigDocumentType, id: string): Promise<void>
}

/**
 * Small key-value state with optional expiry (e.g. what merge request policies already did).
 * Values are JSON-serializable; expired keys read as missing.
 */
export interface KvStore {
  get(key: string): Promise<unknown>
  /** `ttlSeconds` must be positive; without it the key never expires. */
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>
  delete(key: string): Promise<void>
  /** Removes keys expired at `now` (default: the current time); returns how many. */
  sweep(now?: Date): Promise<number>
  /**
   * Takes or renews the lease on `key` for `holder`, atomically across processes sharing the
   * store: granted when the key holds no lease live at `now` (default: the current time) or when
   * `holder` already holds it; the lease then expires `ttlSeconds` after `now`. Resolves with the
   * lease as it is afterwards, so the caller holds it when `holder` matches. The lease is the
   * key's value. Required when several processes share one store (leader election); the memory,
   * SQLite and Postgres stores implement it.
   */
  acquireLease?(key: string, holder: string, ttlSeconds: number, now?: Date): Promise<KvLease>
  /** Drops the lease on `key` when `holder` holds it; `false` when it did not. */
  releaseLease?(key: string, holder: string): Promise<boolean>
  /**
   * Writes `value` only when the key's live value equals `expected` (compared as JSON, key order
   * ignored; `undefined` means missing), atomically across processes sharing the store. `true`
   * when written. Required for store-backed limiter state; memory, SQLite and Postgres implement it.
   */
  compareAndSet?(
    key: string,
    expected: unknown,
    value: unknown,
    ttlSeconds?: number,
  ): Promise<boolean>
}

/** A time-limited claim on a `KvStore` key, see `KvStore.acquireLease`. */
export interface KvLease {
  holder: string
  expiresAt: Timestamp
}

/** How an audited action reached Holtkeeper. */
export type AuditVia = 'ui' | 'api' | 'webhook' | 'job' | 'system'

/** `denied` covers rejected authentication and authorization (401, 403). */
export type AuditOutcome = 'ok' | 'denied' | 'error'

/** Who acted, as known at the time; `provider` is the auth provider or `webhook`, `job`, `system`. */
export interface AuditActor {
  id: string
  name: string
  provider: string
}

/** What an action was about. `repo` is `forge:path` when the object belongs to a repository. */
export interface AuditTarget {
  type: string
  id?: string
  repo?: string
}

/** One changed field (dotted path for nested objects). Secret values are `«redacted»`. */
export interface AuditChange {
  field: string
  before?: unknown
  after?: unknown
}

/** The HTTP request behind an event; absent for jobs and system events. */
export interface AuditRequest {
  method: string
  path: string
  /** Route template, e.g. `/api/credentials/:id`. */
  route?: string
  params?: Record<string, string>
  ip?: string
  userAgent?: string
  durationMs?: number
}

/** What callers append; the store adds `id`, `seq` and the hash chain. */
export interface AuditEventInput {
  at: Timestamp
  actor: AuditActor
  via: AuditVia
  /** Dotted `<object>.<verb>`, e.g. `credential.update`. */
  action: string
  target: AuditTarget
  outcome: AuditOutcome
  /** HTTP status, when there was a request. */
  status?: number
  request?: AuditRequest
  changes?: AuditChange[]
  details?: Record<string, unknown>
}

/**
 * One entry of the append-only audit log. `seq` grows by one per append and is never reused.
 * `hash` is the SHA-256 (hex) of the canonical JSON of every other field, `prevHash` the previous
 * event's `hash` (64 zeros for the first event), so editing, inserting or removing an event
 * breaks the chain.
 */
export interface AuditEvent extends AuditEventInput {
  id: string
  seq: number
  prevHash: string
  hash: string
}

/**
 * Filters for the audit log; every given field must match. `action` is a prefix (`credential`
 * matches `credential.update`), `actor` an actor id, `repo` exact `forge:path`; `from` is
 * inclusive, `to` exclusive.
 */
export interface AuditFilter {
  actor?: string
  action?: string
  targetType?: string
  targetId?: string
  repo?: string
  outcome?: AuditOutcome
  via?: AuditVia
  from?: Timestamp
  to?: Timestamp
}

export interface AuditQuery extends AuditFilter {
  /** `nextCursor` of the previous page. */
  cursor?: string
  /** Default 50. */
  limit?: number
}

/** A page of events, newest first; `nextCursor` is absent on the last page. */
export interface AuditPage {
  events: AuditEvent[]
  nextCursor?: string
}

/** Inclusive `seq` bounds; open ends mean the oldest kept and the newest event. */
export interface AuditChainRange {
  fromSeq?: number
  toSeq?: number
}

/**
 * Result of checking the hash chain. `broken` names the first event that fails: its `hash` does
 * not match its content (`hash`), its `prevHash` does not match the event before it (`link`), an
 * event before it that was not swept is missing (`gap`), or events after it up to the end of the
 * range are missing (`tail`; `seq` is then the last event found, `id` empty when none was).
 */
export interface AuditVerification {
  ok: boolean
  checked: number
  firstSeq?: number
  lastSeq?: number
  broken?: { seq: number; id: string; reason: 'hash' | 'link' | 'gap' | 'tail' }
}

/**
 * The append-only audit log. Appends are serialized so the chain has no forks. Nothing edits
 * events; `sweep` only drops the oldest ones.
 */
export interface AuditStore {
  append(event: AuditEventInput): Promise<AuditEvent>
  get(id: string): Promise<AuditEvent | undefined>
  /** Newest first (by `seq`). */
  list(query?: AuditQuery): Promise<AuditPage>
  count(filter?: AuditFilter): Promise<number>
  /** Every matching event, oldest first, read in batches. */
  export(filter?: AuditFilter): AsyncIterable<AuditEvent>
  /**
   * Retention: removes the oldest events up to (not including) the first one at or after
   * `before`, so the kept events stay one unbroken chain. Returns how many it removed.
   */
  sweep(before: Timestamp): Promise<number>
  /** Recomputes hashes and links in the range; the oldest kept event anchors the chain. */
  verifyChain(range?: AuditChainRange): Promise<AuditVerification>
}

/**
 * How sure Holtkeeper is that an external account belongs to its user: an admin said so, the
 * user signed in through that provider, the user proved control by posting a challenge code, or
 * nobody checked yet.
 */
export type ExternalVerification = 'admin' | 'oidc' | 'challenge' | 'unverified'

/** A pending verification code; only its hash is stored. */
export interface ExternalAccountChallenge {
  hash: string
  expiresAt: Timestamp
  /** Wrong codes posted so far. */
  attempts: number
}

/**
 * A forge, chat or other external account linked to a Holtkeeper principal. `(provider,
 * externalId)` is unique.
 */
export interface ExternalAccount {
  id: string
  /** Holtkeeper principal id: a user id with the `users` provider, else the provider's principal id. */
  userId: string
  /** `gitlab:<forgeId>`, `github:<forgeId>`, `slack:<workspaceId>` or free form. */
  provider: string
  /** The provider's stable user id (numeric for GitLab and GitHub). */
  externalId: string
  username?: string
  verification: ExternalVerification
  /** Principal id that created the link. */
  linkedBy: string
  linkedAt: Timestamp
  verifiedAt?: Timestamp
  challenge?: ExternalAccountChallenge
  /**
   * The principal as last seen, for auth providers without stored users (header, password,
   * none); refreshed whenever that principal manages its links.
   */
  principal?: { name: string; provider: string; grants: Grant[] }
}

/** External accounts linked to principals. */
export interface ExternalAccountStore {
  get(id: string): Promise<ExternalAccount | undefined>
  find(provider: string, externalId: string): Promise<ExternalAccount | undefined>
  /** Oldest link first. */
  listByUser(userId: string): Promise<ExternalAccount[]>
  /** Oldest link first. */
  list(provider?: string): Promise<ExternalAccount[]>
  /**
   * Creates or replaces by id. Rejects with `ExternalAccountConflictError` when another id
   * already links the same `(provider, externalId)`.
   */
  put(account: ExternalAccount): Promise<void>
  remove(id: string): Promise<void>
}

/** Everything Holtkeeper persists. Implementations: in-memory, SQLite; Postgres later. */
export interface Store {
  auditRuns: AuditRunStore
  analyses: AnalysisStore
  credentials: CredentialStore
  settings: SettingStore
  users: UserStore
  activity: ActivityStore
  jobs: JobStore
  knowledge: KnowledgeStore
  aiUsage: AiUsageStore
  ciJobs: CiJobStore
  /** Panel-managed configuration; servers without it use the file config only. */
  config?: ConfigStore
  /** Small expiring state; servers without it keep such state in memory. */
  kv?: KvStore
  /** Tamper-evident audit log; servers without it audit nothing. */
  audit?: AuditStore
  /** External accounts linked to principals; servers without it cannot link accounts. */
  externalAccounts?: ExternalAccountStore
  close(): Promise<void>
}
