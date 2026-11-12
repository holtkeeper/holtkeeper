import type { Grant, GroupMatch, Scope } from '@holtkeeper/access'
import type { Card } from '@holtkeeper/chat'
import type { RepoRef } from '@holtkeeper/forge'
import type { AuditReport } from '@holtkeeper/vuln'

/** ISO 8601 timestamp, e.g. `2026-10-29T12:00:00.000Z`. */
export type Timestamp = string

/** What started an audit run; `freshness` is the server's sweeper keeping results current. */
export type AuditTrigger = 'cli' | 'schedule' | 'freshness' | 'manual' | 'webhook'

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
  /**
   * What a probe found the provider can do, e.g. whether its Messages API runs an agent tool loop.
   * Cleared when the endpoint, secret, kind or options change.
   */
  capabilities?: CredentialCapabilities
  /**
   * When something last used the secret. Moved by `CredentialStore.touch`; `put` keeps the later
   * of the stored and the given value, so a write never moves it back.
   */
  lastUsedAt?: Timestamp
  createdAt: Timestamp
  updatedAt: Timestamp
}

/** Outcome of one capability probe: `unknown` until a probe ran. */
export type CapabilityStatus = 'ok' | 'failed' | 'unknown'

/** Probed capabilities of a credential. */
export interface CredentialCapabilities {
  /** Messages tool use, which the Claude Agent SDK loop needs. */
  agentLoop: CapabilityStatus
  /** When the probe ran. */
  checkedAt: Timestamp
  /** Why the probe failed, without secrets. */
  error?: string
}

export interface CredentialStore {
  list(): Promise<StoredCredential[]>
  get(id: string): Promise<StoredCredential | undefined>
  /** Creates or replaces by id (see `StoredCredential.lastUsedAt`). */
  put(credential: StoredCredential): Promise<void>
  remove(id: string): Promise<void>
  /** Sets `lastUsedAt` to `at` when it is later than the stored value; unknown ids are ignored. */
  touch(id: string, at: Timestamp): Promise<void>
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
  /**
   * When the user last made a signed-in request. Moved by `UserStore.touchUser`; `putUser` keeps
   * the later of the stored and the given value, so a write never moves it back.
   */
  lastSeenAt?: Timestamp
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
  /** Sets `lastSeenAt` to `at` when it is later than the stored value; unknown ids are ignored. */
  touchUser(id: string, at: Timestamp): Promise<void>

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
  /** Commit the analysis ran on: the checked-out HEAD, or the default-branch head it read. */
  sha?: string
  createdAt: Timestamp
  actor?: string
  data: Data
  /**
   * The kind's structured headline numbers (coverage percent, gzip per target, counts per
   * severity, ...), computed from `data` when the record was stored. Stored as given; absent on
   * records stored before metrics existed and on kinds that define none.
   */
  metrics?: AnalysisMetrics
}

/** Plain JSON object of one record's metrics; its shape belongs to the record's kind. */
export type AnalysisMetrics = object

/** An analysis record without its data; `metrics` are kept, so heads answer lists and health. */
export type AnalysisHead = Omit<AnalysisRecord, 'data'>

export interface AnalysisQuery {
  repo?: RepoRef
  kind?: string
  /** Only records created before this time; used for paging and for finding the previous one. */
  before?: Timestamp
  /** Only records created at or after this time; combines with `before` and `limit`. */
  since?: Timestamp
  /** Default 50. */
  limit?: number
}

/** Analysis records, newest first. */
export interface AnalysisStore {
  add(record: Omit<AnalysisRecord, 'id'>): Promise<AnalysisRecord>
  get(id: string): Promise<AnalysisRecord | undefined>
  list(query?: AnalysisQuery): Promise<AnalysisRecord[]>
  /** What `list` returns for the same query, without reading the records' data. */
  heads(query?: AnalysisQuery): Promise<AnalysisHead[]>
  /**
   * The newest record of every (repository, kind) pair, newest first; only pairs of `repo` and
   * of `kind` when given. Among records created at the same time the last added wins.
   */
  latest(query?: Pick<AnalysisQuery, 'repo' | 'kind'>): Promise<AnalysisRecord[]>
  /** What `latest` returns for the same query, without reading the records' data. */
  latestHeads(query?: Pick<AnalysisQuery, 'repo' | 'kind'>): Promise<AnalysisHead[]>
  /**
   * Deletes the records of `kind` for `repo` except the newest `keep` (by creation time, the last
   * added first among equal times) and returns how many it deleted.
   */
  prune(query: { repo: RepoRef; kind: string; keep: number }): Promise<number>
}

/**
 * What queued a job. `manual` (the panel or API) and `command` (a command in a merge request
 * comment) mean a person asked for it; the others are automatic.
 */
export type JobTrigger =
  | 'schedule'
  | 'manual'
  | 'command'
  | 'webhook'
  | 'tag'
  | 'push'
  | 'poll'
  | 'new-repo'
  | 'freshness'

/** `blocked`: an AI budget refused or stopped the run; it is not retried and is not a failure. */
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'canceled'

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
  /**
   * `errorSignature(error)` of the latest failed attempt, so equal failures of different jobs
   * compare equal; cleared when the job succeeds or is blocked.
   */
  errorSignature?: string
  /** One entry per attempt started, oldest first; the last one is the current or latest attempt. */
  attemptsHistory: JobAttempt[]
  /** The stored result, once the job succeeded. */
  analysisId?: string
  /** Principal id that requested the job, when a person did. */
  actor?: string
  /** Name of the schedule that queued the job, also for its manual runs. */
  schedule?: string
  /** Why the automation that queued the job did, e.g. `sha 1a2b3c4 != head 5d6e7f8`. */
  reason?: string
}

/** How one attempt of a job ended; `running` while it still runs. */
export type JobAttemptStatus = 'running' | 'succeeded' | 'failed' | 'blocked' | 'canceled'

/**
 * One attempt of a job: `claim` starts it; `complete`, `fail`, `block`, `cancel` or
 * `recoverStale` ends it.
 */
export interface JobAttempt {
  /** 1-based, equal to `Job.attempts` when the attempt started. */
  n: number
  status: JobAttemptStatus
  startedAt: Timestamp
  finishedAt?: Timestamp
  workerId?: string
  error?: string
  /** The step that failed (see `JobStore.fail`), when the worker knew it. */
  step?: string
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
  reason?: string
}

export interface JobQuery {
  status?: JobStatus | JobStatus[]
  repo?: RepoRef
  analyzer?: string
  /** Only jobs queued by this schedule. */
  schedule?: string
  /** Only jobs queued by this kind of event. */
  trigger?: JobTrigger
  /** Only jobs created before this time; used for paging. */
  before?: Timestamp
  /** Only jobs whose `errorSignature` is exactly this. */
  errorSignature?: string
  /** Only jobs whose stored result is this analysis: the job (or jobs) that produced it. */
  analysisId?: string
  /**
   * Only jobs of these repositories (group jobs by `{ forge, path: <group name> }`); an empty list
   * matches nothing. Lets callers apply visibility before `limit`.
   */
  repos?: RepoRef[]
  /**
   * Only jobs whose id starts with `search.text`, whose repository path, group or analyzer
   * contains it (all case-insensitive), or whose analyzer is one of `search.analyzers`.
   */
  search?: JobSearch
  /** Default 50. */
  limit?: number
}

/** A text search over jobs; see `JobQuery.search`. */
export interface JobSearch {
  text: string
  /** Analyzer kinds that match as well, e.g. those whose label contains `text`. */
  analyzers?: string[]
}

/** Which jobs `JobStore.count` counts: the filters of `JobQuery`, without paging. */
export interface JobCountQuery extends Omit<JobQuery, 'before' | 'limit'> {
  /** Only jobs created at or after this time. */
  since?: Timestamp
}

/** How many jobs match a `JobCountQuery`, by status. */
export interface JobCounts {
  total: number
  /** Every status, zero included; sums to `total`. */
  byStatus: Record<JobStatus, number>
}

/** Which failed jobs `JobStore.failures` groups. */
export interface JobFailureQuery {
  /** Only jobs that failed for good at or after this time. */
  since: Timestamp
  analyzer?: string
  /** As `JobQuery.repos`. */
  repos?: RepoRef[]
  /** Groups returned at most. Default 50. */
  limit?: number
}

/** Jobs that failed for good with the same analyzer and `errorSignature`. */
export interface JobFailureGroup {
  analyzer: string
  errorSignature: string
  count: number
  /** Distinct repositories (or groups) among them. */
  repos: number
  firstAt: Timestamp
  lastAt: Timestamp
  /** The job that failed last, and its raw error. */
  latestJobId: string
  error: string
}

/** A repository or group that has jobs, as `JobStore.targets` lists it. */
export interface JobTarget {
  repo: RepoRef
  group?: string
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
  /**
   * Only jobs due for at least this long, so workers without a delay get new jobs first and this
   * one takes what they leave. Default 0.
   */
  delayMs?: number
  /** Only jobs of these kinds (a dedicated worker pool). Absent: every kind. */
  only?: string[]
  /** Never jobs of these kinds (they belong to another worker pool). */
  except?: string[]
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
   * Records a failed attempt of a running job, with `step` as the step that failed, and sets
   * `errorSignature` from `error`. With `retryAt` and attempts left it goes back to the queue to
   * run after `retryAt`; otherwise it is failed for good.
   */
  fail(
    id: string,
    failure: { at: Timestamp; error: string; retryAt?: Timestamp; step?: string },
  ): Promise<Job | undefined>
  /** Marks a running job `blocked` for good with the reason in `error`; it is not retried. */
  block(id: string, blocked: { at: Timestamp; error: string }): Promise<Job | undefined>
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
  /** How many jobs match, by status; without a query every job. */
  count(query?: JobCountQuery): Promise<JobCounts>
  /** Failed jobs grouped by analyzer and `errorSignature`, the group that failed last first. */
  failures(query: JobFailureQuery): Promise<JobFailureGroup[]>
  /** Every distinct repository or group that has jobs, in no particular order. */
  targets(): Promise<JobTarget[]>
}

export type KnowledgeKind = 'decision' | 'convention' | 'migration' | 'quirk' | 'howto'

export type KnowledgeStatus = 'proposed' | 'accepted' | 'rejected' | 'archived'

/**
 * Who reads an entry: `team` (default) the people its scope covers; `shared` also everyone with
 * cross-team catalog reach, so a team's decision about a library reaches other teams.
 */
export type KnowledgeVisibility = 'team' | 'shared'

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
  /** Absent means `team`. */
  visibility?: KnowledgeVisibility
  /**
   * What the entry is about, as a join key for pages and tools: a library or package
   * (`npm:react`, `Go:github.com/acme/kit`) or a stack tool (`tool:node`).
   */
  subject?: string
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
  /** Exact `subject`. */
  subject?: string
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

/** The fixed sections of a Guide, in the order prompts and the panel show them. */
export type GuideSectionName =
  | 'general'
  | 'review'
  | 'testing'
  | 'testids'
  | 'assets'
  | 'commits'
  | 'releases'

/**
 * Where a Guide section applies, as a key: `all`, `group:<config group>`, `family:<family id>` or
 * `repo:<forge>:<path>`.
 */
export type GuideScopeKey = 'all' | `group:${string}` | `family:${string}` | `repo:${string}`

/** The text a generator proposed for a section from repository signals; humans accept it. */
export interface GuideGenerated {
  /**
   * Which generator run of this scope and section stored the text: 1 for the first, up by one per
   * run that stored new text. The store assigns it.
   */
  version: number
  /** The job that generated the text, when a job did. */
  jobId?: string
  /** Markdown. */
  body: string
  /** Hash of everything the generator read; an unchanged hash means no new LLM call. */
  inputHash: string
  model: string
  costUsd: number
  status: 'proposed' | 'accepted'
  generatedAt: Timestamp
  /** Commit the signals were read at. */
  sha?: string
  /** The one-off extra prompt a person gave for this run, kept for traceability. */
  prompt?: string
  /** Who accepted the text and when; absent while it is proposed. */
  acceptedBy?: string
  acceptedAt?: Timestamp
}

/** A short rule people accepted from review replies or reactions, with where it came from. */
export interface GuideLearning {
  id: string
  /** One imperative sentence. */
  rule: string
  sources: KnowledgeLink[]
  acceptedBy: string
  acceptedAt: Timestamp
}

/** The human-written part of a section, the part revisions track. */
export interface GuideHumanLayer {
  /** Team rules in Markdown; empty when nobody wrote any. */
  rules: string
  /** A short prompt that steers the generator; never put into task prompts. */
  steering: string
}

/**
 * One section of one scope's Guide. Human rules always outrank the generated layer. `version`
 * counts edits of the human layer: 0 before the first one, then up by one per change of `rules`
 * or `steering`.
 */
export interface GuideSection extends GuideHumanLayer {
  scope: GuideScopeKey
  section: GuideSectionName
  version: number
  /** Who made the current human layer and when; absent before the first edit. */
  editedBy?: string
  editedAt?: Timestamp
  /**
   * The generated text agents see: accepted text, or a first proposal nobody accepted yet (agents
   * get that one only when no human rules apply).
   */
  generated?: GuideGenerated
  /** A newer proposal waiting for a person while `generated` holds accepted text. */
  proposal?: GuideGenerated
  learnings: GuideLearning[]
}

/**
 * A generated layer as `GuideStore.put` takes it: `version` is assigned by the store and only kept
 * for a layer it already stored.
 */
export type GuideGeneratedInput = Omit<GuideGenerated, 'version'> & { version?: number }

/** What `GuideStore.put` takes: the section without the versions the store assigns. */
export type GuideSectionInput = Omit<GuideSection, 'version' | 'generated' | 'proposal'> & {
  generated?: GuideGeneratedInput
  proposal?: GuideGeneratedInput
}

/** A previous human layer of a section, with who made it and when. */
export interface GuideRevision extends GuideHumanLayer {
  version: number
  editedBy: string
  editedAt: Timestamp
}

/** Filters for `GuideStore.list`; every given field must match. */
export interface GuideFilter {
  scopes?: readonly GuideScopeKey[]
  sections?: readonly GuideSectionName[]
}

/** Guide sections, one row per scope and section, with revisions of their human layer. */
export interface GuideStore {
  get(scope: GuideScopeKey, section: GuideSectionName): Promise<GuideSection | undefined>
  /** Sorted by scope, then section name. */
  list(filter?: GuideFilter): Promise<GuideSection[]>
  /**
   * Creates or replaces the section and returns it. When `rules` or `steering` differ from the
   * stored ones, the previous human layer goes to the history (with its `editedBy`/`editedAt`)
   * and `version` grows by one; otherwise `version`, `editedBy` and `editedAt` stay as stored, so
   * writing the generated layer or learnings never makes a revision.
   *
   * A generated layer (`generated` or `proposal`) with the `generatedAt` and `body` of a layer
   * the section already holds keeps that layer's `version` (accepting a proposal, refreshing the
   * hash of kept text); any other layer is a new generator run: it gets the next version of the
   * section and is appended to the generated history. The history entry of a stored version
   * follows later writes of that version, so it shows acceptance too.
   */
  put(section: GuideSectionInput): Promise<GuideSection>
  /** Previous human layers, newest first; empty for unknown sections. */
  history(scope: GuideScopeKey, section: GuideSectionName): Promise<GuideRevision[]>
  /**
   * Every generated layer the section ever stored with a version above 0, newest version first,
   * each as last written; empty for unknown sections.
   */
  generatedHistory(scope: GuideScopeKey, section: GuideSectionName): Promise<GuideGenerated[]>
  /** Removes every section of the scope, their history and their generated history. */
  removeScope(scope: GuideScopeKey): Promise<void>
}

/**
 * A named set of similar repositories, e.g. near-identical app frontends of one team. A repository
 * belongs to at most one family.
 */
export interface Family {
  id: string
  name: string
  /** Repositories as `forge:path`, sorted. */
  members: string[]
  createdBy: string
  createdAt: Timestamp
  updatedAt: Timestamp
  updatedBy?: string
}

/** Confirmed families. */
export interface FamilyStore {
  /** Sorted by name. */
  list(): Promise<Family[]>
  get(id: string): Promise<Family | undefined>
  /**
   * Creates or replaces by id. Throws `FamilyConflictError` when a member belongs to another
   * family; nothing is written then.
   */
  put(family: Family): Promise<void>
  remove(id: string): Promise<void>
}

/** One merge request note a learning candidate came from. */
export interface LearningSource {
  /** `forge:path`. */
  repo: string
  mergeRequest: number
  discussionId: string
  noteId: string
  /** The note author's forge username; shown next to the candidate, never put into rule text. */
  author: string
  at: Timestamp
  /** Link to the note, when the forge reported the merge request's URL. */
  url?: string
}

export type LearningStatus = 'proposed' | 'accepted' | 'rejected'

/** Where a candidate's rule should apply once accepted. */
export type LearningScopeKind = 'repo' | 'family' | 'group'

/** Who proposed a rule directly (an MCP client, through `propose_rule_change`) and why. */
export interface LearningProposal {
  /** Principal id of the proposer. */
  by: string
  reason: string
}

/**
 * A rule extracted from replies to Holtkeeper's review comments, or proposed directly. It reaches
 * prompts only after a person accepts it: it is then a `GuideLearning` (same `id`) of the
 * `acceptedScope` section.
 */
export interface LearningCandidate {
  id: string
  /** `forge:path` of the repository the first reply was in. */
  repo: string
  /** One imperative sentence, at most 200 characters, without personal names. */
  rule: string
  /** `rule` normalized; one repository holds one candidate per key. */
  key: string
  section: GuideSectionName
  suggestedScope: LearningScopeKind
  status: LearningStatus
  /** Every reply that taught the rule, oldest first; empty for a direct proposal. */
  sources: LearningSource[]
  /** Set for a rule proposed directly rather than learned from a reply. */
  proposal?: LearningProposal
  /** Model of the extraction and what it cost. */
  model: string
  costUsd: number
  createdAt: Timestamp
  updatedAt: Timestamp
  /** Where the accepted rule lives. */
  acceptedScope?: GuideScopeKey
  /** Who accepted or rejected it and when. */
  decidedBy?: string
  decidedAt?: Timestamp
  editedBy?: string
}

export interface LearningFilter {
  /** `forge:path` values. */
  repos?: readonly string[]
  status?: readonly LearningStatus[]
}

/** 👍/👎 counts on one of Holtkeeper's review comments, as last read from the forge. */
export interface ReactionSignal {
  /** `forge:path`. */
  repo: string
  mergeRequest: number
  noteId: string
  /** Finding category of the comment, e.g. `bug`, `style`. */
  category: string
  findingId?: string
  up: number
  down: number
  updatedAt: Timestamp
}

/** Reaction counts summed over comments of one category. */
export interface ReactionTotals {
  category: string
  comments: number
  up: number
  down: number
}

/** Learning candidates, the reply notes already looked at, and reaction counts of review comments. */
export interface LearningStore {
  get(id: string): Promise<LearningCandidate | undefined>
  /** Most recently updated first. */
  list(filter?: LearningFilter): Promise<LearningCandidate[]>
  /** The candidate of `repo` whose `key` matches. */
  find(repo: string, key: string): Promise<LearningCandidate | undefined>
  /** Creates or replaces by id. */
  put(candidate: LearningCandidate): Promise<void>
  /**
   * Marks a source as handled; `true` only for the first caller of `key`, atomically across
   * processes sharing the store.
   */
  claim(key: string, at: Timestamp): Promise<boolean>
  /** Forgets a claim, so the source may be handled again (e.g. after a failed call). */
  release(key: string): Promise<void>
  /** Creates or replaces the counts of one comment (by repo, merge request and note). */
  putReactions(signal: ReactionSignal): Promise<void>
  /** Counts per category, sorted by category; `repos` limits them to those repositories. */
  reactionTotals(filter?: { repos?: readonly string[] }): Promise<ReactionTotals[]>
  /** The counts of every comment on `repo`'s merge requests, only those of `mergeRequests` when given. */
  reactions(filter: { repo: string; mergeRequests?: readonly number[] }): Promise<ReactionSignal[]>
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
  /**
   * A person started the work (a click in the panel, chat, a command on a merge request), so it
   * could spend the budget reserve; `false` for automatic work (schedules, triggers, freshness).
   */
  interactive: boolean
  /** What the run worked on in a few words, e.g. `MR !42` or `v2.3.0`, when the caller said. */
  subject?: string
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
  /** Artifact id of the run's JSONL transcript, when one was written. */
  transcriptRef?: string
}

/** A new AI usage record; `interactive` defaults to `false`. */
export type NewAiUsageRecord = Omit<AiUsageRecord, 'id' | 'interactive'> & { interactive?: boolean }

/** Who started AI runs: a person (`interactive`) or automation (`automatic`). */
export type AiRunOrigin = 'interactive' | 'automatic'

/** Filters for AI usage. Every given field must match; `from` is inclusive, `to` exclusive. */
export interface AiUsageFilter {
  from?: Timestamp
  to?: Timestamp
  repo?: RepoRef
  /** Records whose `groups` contain this group. */
  group?: string
  /** Records whose `groups` contain at least one of these groups; an empty list matches nothing. */
  groups?: string[]
  actor?: string
  /** `interactive` records only, or automatic ones only. */
  origin?: AiRunOrigin
  model?: string
  provider?: string
  taskKind?: string
  /** Records whose `taskKind` is one of these; an empty list matches nothing. */
  taskKinds?: string[]
  analyzer?: string
  outcome?: AiRunOutcome
  jobId?: string
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
 * `origin` is `interactive` or `automatic` (`AiRunOrigin`).
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
  | 'origin'

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
  /** Records whose cost is unknown (`costSource` `unknown`), denied ones excluded. */
  unknownCost: number
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
  append(record: NewAiUsageRecord): Promise<AiUsageRecord>
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
  /** Events the hook was registered for; missing on hooks registered before this was recorded. */
  events?: string[]
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
  /**
   * The egress proxy also keeps the package files jobs download from this forge's registries
   * (npm, Maven, PyPI, generic) in its download cache. Cached copies outlive the token's access.
   * Default off; needs `packages`.
   */
  cachePackages?: boolean
  /** Username Holtkeeper posts as on this forge; its own events and merge requests are ignored. */
  botUsername?: string
  webhook?: ForgeWebhook
  sshKey?: ForgeSshKey
}

/**
 * A group of repositories, as `groups.<id>` of the effective config. The id is a root group
 * (`shapes`) or a subgroup (`shapes.round`, see `GROUP_KEY_PATTERN` in `@holtkeeper/access`): a
 * subgroup's parent is the part before the dot, its forge equals the parent's and its members are
 * the parent's members its own patterns match.
 */
export interface GroupDocumentData {
  /** Display name shown instead of the id; the id stays the identity in grants, scopes and guides. */
  title?: string
  forge: string
  include: string[]
  exclude: string[]
}

/** Traits for repositories matching `pattern`, as `repos.<pattern>` of the effective config. */
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
 * An event trigger managed in the panel. Document ids are fixed per entry: `tag`, `push`,
 * `merge-request`, `new-repo`, `label:<label>` and `command:<name>`.
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
  | { on: 'newRepo'; analyzers?: string[]; exclude?: string[]; groups?: GroupMatch[] }
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
 * matches `credential.update`), `actor` an actor id, `repo` exact `forge:path`; `repos` keeps
 * only events whose `target.repo` is one of the list (an empty list matches nothing); `from` is
 * inclusive, `to` exclusive.
 */
export interface AuditFilter {
  actor?: string
  action?: string
  targetType?: string
  targetId?: string
  repo?: string
  repos?: readonly string[]
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

/** How many matching events one value of a summary dimension has. */
export interface AuditCount {
  key: string
  count: number
}

/**
 * Aggregate of the events matching a filter. `days` are UTC calendar days (`YYYY-MM-DD`) that
 * have events, oldest first. `actions` (full action names), `actors` (actor ids, `name` from the
 * actor's newest matching event) and `repos` (events without `target.repo` are left out) are
 * sorted by count, most first, then by key.
 */
export interface AuditSummary {
  total: number
  days: AuditCount[]
  actions: AuditCount[]
  actors: (AuditCount & { name: string })[]
  repos: AuditCount[]
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
  /** Counts of the matching events by day, action, actor and repository (see `AuditSummary`). */
  summary(filter?: AuditFilter): Promise<AuditSummary>
  /** Every distinct `target.repo` among the kept events, sorted. */
  repos(): Promise<string[]>
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
  /** `gitlab:<forgeId>`, `github:<forgeId>` or free form. */
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

/** Package ecosystem of a third-party library, in OSV spelling. */
export type LibraryEcosystem = 'npm' | 'Go'

/** A third-party library. Go majors (`/v2`, `/v3`) are one library named by the module path without the suffix. */
export interface LibraryRef {
  ecosystem: LibraryEcosystem
  name: string
}

/**
 * Why a version is indexed: `used` by some repository, the newest `patch` of a used minor, the
 * newest `minor` of a used major, the newest release of a `major` above the highest used one,
 * the `first` release of such a major, or the newest stable release (`latest`).
 */
export type LibraryVersionRole = 'used' | 'patch' | 'minor' | 'major' | 'first' | 'latest'

/** A place documents of a library come from. */
export type LibrarySourceKind =
  | 'registry'
  | 'archive'
  | 'api'
  | 'repository'
  | 'releases'
  | 'source'
  | 'issues'
  | 'site'

/** Outcome of the last fetch of one source. `missing`: the source does not exist for it. */
export interface LibrarySourceStatus {
  status: 'ok' | 'missing' | 'failed' | 'skipped'
  at: Timestamp
  message?: string
}

/** Where a library's code lives, from registry metadata. */
export interface LibraryRepository {
  /** `github.com`, `gitlab.com`, ... */
  host: string
  /** `owner/name` on that host. */
  path: string
  /** Folder of the package inside a monorepo repository, without leading or trailing slashes. */
  directory?: string
  url: string
}

/** One indexed library. */
export interface LibraryRecord extends LibraryRef {
  description?: string
  homepage?: string
  repository?: LibraryRepository
  /** Newest stable release the registry knows. */
  latest?: string
  /** Library-wide sources: `registry`, `issues`, `site`. */
  sources: Partial<Record<LibrarySourceKind, LibrarySourceStatus>>
  /** Opaque incremental position of the issue index. */
  issuesCursor?: string
  updatedAt: Timestamp
}

/** One indexed version of a library. */
export interface LibraryVersionRecord extends LibraryRef {
  version: string
  publishedAt?: Timestamp
  /** Registry deprecation message. */
  deprecated?: string
  /** Empty once the version left the matrix; see `leftAt`. */
  roles: LibraryVersionRole[]
  /** Repositories resolving to this version, as `forge:path`. */
  usedBy: string[]
  /** Tag of the version in `LibraryRecord.repository`, when one was found. */
  tag?: string
  /** Commit of the version (npm `gitHead`, or the tag's commit). */
  commit?: string
  /** Artifact id of the version's API as JSON `ApiPackage[]` of `@holtkeeper/api-surface`. */
  api?: string
  /** Artifact id of a ZIP of the version's source, made on demand. */
  sourceArchive?: string
  /** Per-version sources: `archive`, `api`, `repository`, `releases`, `source`. */
  sources: Partial<Record<LibrarySourceKind, LibrarySourceStatus>>
  /** When the version last left the matrix; cleared when it returns. */
  leftAt?: Timestamp
  updatedAt: Timestamp
}

/** A section of a library document. Identical sections of several versions are one chunk. */
export interface LibraryChunk extends LibraryRef {
  /** Stable for the same library, source, path, headings and text. */
  id: string
  /** Versions that ship this chunk, highest first. */
  versions: string[]
  source: 'archive' | 'repository' | 'releases' | 'site'
  /** File path inside the package or repository, or the URL path of a page. */
  path: string
  /** Heading path from the document title down to the section. */
  headings: string[]
  /** GitHub-style slug of the last heading. */
  anchor?: string
  /** Markdown of the section. */
  text: string
  url?: string
}

/** A chunk with its relevance; higher is better, comparable within one result only. */
export interface LibraryChunkHit {
  chunk: LibraryChunk
  score: number
}

export interface LibraryChunkFilter {
  ecosystem?: LibraryEcosystem
  name?: string
  /** Only chunks shipped by this version. */
  version?: string
  source?: LibraryChunk['source']
  /** Exact path. */
  path?: string
}

/** LLM summary of an issue thread. */
export interface LibraryIssueDigest {
  problem: string
  /** Error messages and symptoms as reported. */
  symptoms: string[]
  affected?: string
  fixedIn?: string
  workaround?: string
  at: Timestamp
}

/** An issue or discussion of a library's repository. */
export interface LibraryIssue extends LibraryRef {
  /** `<host>/<owner>/<repo>#<number>`. */
  id: string
  number: number
  kind: 'issue' | 'discussion'
  title: string
  state: 'open' | 'closed'
  labels: string[]
  url: string
  /** First message, trimmed. */
  body: string
  /** Accepted answer or the most useful maintainer reply, trimmed. */
  answer?: string
  /** Pull requests that closed or reference it. */
  pulls: number[]
  /** Release that shipped the fix, when known. */
  fixedIn?: string
  reactions: number
  comments: number
  createdAt: Timestamp
  updatedAt: Timestamp
  closedAt?: Timestamp
  digest?: LibraryIssueDigest
}

export interface LibraryIssueHit {
  issue: LibraryIssue
  score: number
}

/** How much the index holds of one library. */
export interface LibraryStats {
  /** Version records, the ones in their grace period included. */
  versions: number
  chunks: number
  issues: number
}

/**
 * Third-party library documentation: libraries, their indexed versions, document chunks and
 * issues. Search treats any text as plain words; quoted phrases match as phrases.
 */
export interface LibraryStore {
  putLibrary(record: LibraryRecord): Promise<void>
  getLibrary(ref: LibraryRef): Promise<LibraryRecord | undefined>
  /** By ecosystem, then name. `query` keeps names containing it, case-insensitively. */
  listLibraries(filter?: { ecosystem?: LibraryEcosystem; query?: string }): Promise<LibraryRecord[]>
  /** Removes the library with its versions, chunks and issues. */
  removeLibrary(ref: LibraryRef): Promise<void>

  /** Creates or replaces by `(ecosystem, name, version)`. */
  putVersion(record: LibraryVersionRecord): Promise<void>
  getVersion(ref: LibraryRef, version: string): Promise<LibraryVersionRecord | undefined>
  /** Every version of the library, highest semantic version first. */
  listVersions(ref: LibraryRef): Promise<LibraryVersionRecord[]>
  /** Removes the version and drops it from its chunks; chunks left without versions go. */
  removeVersion(ref: LibraryRef, version: string): Promise<void>

  /**
   * Makes `chunks` (their `versions` ignored) exactly the chunks `version` ships from `source`:
   * the version is added to each, chunks stored before are reused by id, and the version is
   * dropped from its other chunks of that source. Chunks left without versions go.
   */
  replaceChunks(
    ref: LibraryRef,
    version: string,
    source: LibraryChunk['source'],
    chunks: Omit<LibraryChunk, 'versions'>[],
  ): Promise<void>
  /** Matching chunks in path order, then document order. `limit` defaults to 200. */
  listChunks(filter: LibraryChunkFilter, limit?: number): Promise<LibraryChunk[]>
  /** Blank text returns nothing; heading matches weigh more than text. `limit` defaults to 20. */
  searchChunks(
    text: string,
    filter?: LibraryChunkFilter,
    limit?: number,
  ): Promise<LibraryChunkHit[]>

  /** Creates or replaces by id. */
  putIssues(issues: LibraryIssue[]): Promise<void>
  getIssue(id: string): Promise<LibraryIssue | undefined>
  /** Title, digest and body matches, in that weight order. `limit` defaults to 20. */
  searchIssues(
    text: string,
    filter?: { ecosystem?: LibraryEcosystem; name?: string; state?: LibraryIssue['state'] },
    limit?: number,
  ): Promise<LibraryIssueHit[]>

  /**
   * Counts of every stored library (zeros included), keyed by `<ecosystem>:<name>`, in one
   * query; only libraries of `ecosystem` when given.
   */
  libraryStats(filter?: { ecosystem?: LibraryEcosystem }): Promise<Map<string, LibraryStats>>
}

/** Database engine behind a `DatabaseInspector`. */
export type DatabaseEngine = 'postgres' | 'sqlite'

/** Client connections to the database, by state. */
export interface DatabaseConnections {
  active: number
  idle: number
  idleInTransaction: number
  /** Connections waiting for a lock. */
  waiting: number
  total: number
  max: number
}

/** One streaming replica as the primary sees it. */
export interface DatabaseReplica {
  name: string
  state: string
  /** `async`, `sync`, `quorum` or `potential`. */
  sync: string
  /** WAL bytes the replica has not replayed yet; missing without the right to see it. */
  lagBytes?: number
  replayLagSeconds?: number
}

/** The database as a whole. Fields an engine cannot report are left out. */
export interface DatabaseOverview {
  engine: DatabaseEngine
  version: string
  /** Size of the whole database (all schemas for Postgres, the main file for SQLite). */
  bytes: number
  /** Allocated but unused space a vacuum would return (SQLite freelist). */
  freeBytes?: number
  startedAt?: Timestamp
  /** Share of block reads served from the buffer cache since `statsResetAt`, 0..1. */
  cacheHitRatio?: number
  commits?: number
  rollbacks?: number
  deadlocks?: number
  statsResetAt?: Timestamp
  connections?: DatabaseConnections
  /** Whether this connection reached a read-only standby. */
  standby?: boolean
  /** Streaming replicas; missing when the engine has none or they cannot be listed. */
  replicas?: DatabaseReplica[]
}

/** One table of the store's schema. Counters missing when the engine keeps no statistics. */
export interface DatabaseTable {
  name: string
  /** Row count; an estimate on Postgres. */
  rows: number
  /** Heap (main fork) bytes. */
  dataBytes: number
  indexBytes: number
  /** Out-of-line storage of large values (Postgres TOAST). */
  toastBytes: number
  totalBytes: number
  deadRows?: number
  lastVacuumAt?: Timestamp
  lastAnalyzeAt?: Timestamp
  seqScans?: number
  indexScans?: number
}

/** One index of the store's schema. */
export interface DatabaseIndex {
  name: string
  table: string
  bytes: number
  /** Scans since statistics were reset; missing when the engine keeps none. */
  scans?: number
  /** The `CREATE INDEX` statement. */
  definition: string
  unique: boolean
  primary: boolean
}

/** Execution statistics of one normalized statement. */
export interface DatabaseQueryStat {
  id: string
  /** Normalized text: literals replaced by `$1`, `$2`, … */
  query: string
  calls: number
  totalMs: number
  meanMs: number
  maxMs: number
  rows: number
  /** Share of shared blocks found in the cache, 0..1. */
  cacheHitRatio?: number
}

/** Order of `DatabaseInspector.queries`: total time, mean time or call count, highest first. */
export type DatabaseQuerySort = 'total' | 'mean' | 'calls'

/** Statement statistics, or why the engine has none. */
export type DatabaseQueries =
  | {
      available: true
      queries: DatabaseQueryStat[]
      resetAt?: Timestamp
      /** Whether `resetQueries` is allowed for the store's user. */
      resettable: boolean
    }
  | { available: false; reason: string }

/** One client connection other than the inspector's own. */
export interface DatabaseSession {
  pid: number
  user?: string
  application?: string
  client?: string
  /** `active`, `idle`, `idle in transaction`, … */
  state: string
  /** The running or last statement, cut to 1000 characters. */
  query?: string
  connectedAt?: Timestamp
  transactionStartedAt?: Timestamp
  queryStartedAt?: Timestamp
  /** `Lock:transactionid` and the like while waiting. */
  waitingFor?: string
  /** Sessions holding the locks this one waits for. */
  blockedBy: number[]
}

/** One applied schema migration. */
export interface DatabaseMigration {
  version: number
  appliedAt: Timestamp
}

/**
 * Read-only introspection of the database a store lives in, for the admin UI. Every method is
 * safe to call at any time and touches only catalog and statistics views, never the store's rows.
 * Tables and indexes are those of the store's own schema.
 */
export interface DatabaseInspector {
  readonly engine: DatabaseEngine
  overview(): Promise<DatabaseOverview>
  /** Largest first. */
  tables(): Promise<DatabaseTable[]>
  /** Largest first. */
  indexes(): Promise<DatabaseIndex[]>
  /** The top `limit` (default 50) statements by `sort` (default `total`) of this database. */
  queries(options?: { sort?: DatabaseQuerySort; limit?: number }): Promise<DatabaseQueries>
  /** Clears statement statistics; missing when the engine has none. Throws without the right. */
  resetQueries?(): Promise<void>
  /** Client connections to this database, longest-running statement first. */
  sessions(): Promise<DatabaseSession[]>
  /** Applied schema migrations, oldest first. */
  migrations(): Promise<DatabaseMigration[]>
}

/** Who wrote a chat message: a person, Holtkeeper's agent, or Holtkeeper itself (command answers, notices). */
export type ChatAuthorType = 'human' | 'agent' | 'system'

/**
 * The running summary of a thread's older messages. It covers every message up to and including
 * `uptoMessageId`; prompts use it instead of those messages.
 */
export interface ChatThreadSummary {
  text: string
  uptoMessageId: string
  /** Estimated tokens of the messages the summary stands for. */
  tokens: number
}

/**
 * A team chat thread. Scoped to a repository (`repo`, `forge:path`) or a config group (`group`)
 * it is visible to people who may read that scope; unscoped it is visible to everyone with chat
 * access. `updatedAt` moves with every new message.
 */
export interface ChatThread {
  id: string
  title: string
  /**
   * Set while `title` is a placeholder waiting to be named from the first message; cleared once a
   * title is generated or a person sets one. Absent means the title is final.
   */
  titlePending?: boolean
  repo?: string
  group?: string
  createdBy: string
  createdAt: Timestamp
  updatedAt: Timestamp
  archived: boolean
  /** The agent answers every human message, not only those that mention it. */
  autoReply: boolean
  /** Principal ids of people who wrote or were mentioned, in order of first appearance. */
  participants: string[]
  /**
   * Repositories (`forge:path`) people attached to the thread as context, in the order given and
   * without duplicates; empty when none.
   */
  contextRepos: string[]
  /**
   * The name and email each poster last wrote under, by principal id, so prompts can scrub them
   * also for people without a `users` account (header sign-in).
   */
  people?: ChatPerson[]
  summary?: ChatThreadSummary
  /** Set while the agent writes a reply. */
  replyingSince?: Timestamp
  /** Who holds the reply claim (see `ChatThreadPatch.claimReply`); set with `replyingSince`. */
  replyingBy?: string
}

/** How a poster of a chat thread signed in: never shown to the model. */
export interface ChatPerson {
  id: string
  name?: string
  email?: string
}

/** What `ChatStore.createThread` takes. */
export type ChatThreadInput = Omit<
  ChatThread,
  'updatedAt' | 'archived' | 'participants' | 'contextRepos'
> &
  Partial<Pick<ChatThread, 'participants' | 'contextRepos'>>

/** Which threads `ChatStore.listThreads` returns. */
export interface ChatThreadFilter {
  /** `false` (default) unarchived threads, `true` only archived ones, `'all'` both. */
  archived?: boolean | 'all'
  /**
   * Only threads whose title contains this text, ignoring case and surrounding blanks; blank text
   * filters nothing.
   */
  q?: string
}

/** Fields of a thread `ChatStore.updateThread` may change; `null` clears an optional one. */
export interface ChatThreadPatch {
  /** A title a person set; it clears `titlePending`. */
  title?: string
  /**
   * A title named from the first message: applied, clearing `titlePending`, only while the stored
   * thread still has `titlePending`; otherwise ignored, so a person's title is never replaced.
   */
  generatedTitle?: string
  archived?: boolean
  autoReply?: boolean
  participants?: string[]
  /** Replaces `contextRepos`; duplicates are dropped, first occurrence kept. */
  contextRepos?: string[]
  /** Appends the ids not yet among `participants`, in order, to the thread as stored. */
  addParticipants?: string[]
  /** Replaces the entries of `people` with these ids, or adds them, as stored. */
  rememberPeople?: ChatPerson[]
  summary?: ChatThreadSummary | null
  /**
   * Takes the reply claim (`replyingSince = at`, `replyingBy = by`) when nobody holds it or the
   * held claim started before `staleBefore`; otherwise the claim stays as it is.
   */
  claimReply?: { by: string; at: Timestamp; staleBefore: Timestamp }
  /** Drops the reply claim when `by` still holds it. */
  releaseReply?: string
}

/** One tool the agent used for a reply and how often. */
export interface ChatToolUse {
  tool: string
  calls: number
}

/**
 * Something a chat message refers to, stored with the message so views never parse bodies:
 * a repository, a job, an agent task, a knowledge note or a merge request. `repo` (`forge:path`)
 * is set whenever the thing belongs to a repository, so readers can hide what they may not see.
 */
export type ChatMessageRef =
  | { kind: 'repo'; repo: string }
  | { kind: 'job'; id: string; repo?: string }
  | { kind: 'task'; id: string; repo?: string }
  | { kind: 'note'; id: string }
  | { kind: 'mr'; repo: string; iid: number }

/**
 * One message of a thread. `seq` is assigned by the store, grows with every message of the
 * store and orders messages; cursors are `seq` values.
 */
export interface ChatMessage {
  id: string
  threadId: string
  seq: number
  authorType: ChatAuthorType
  /** Principal id of a human author; absent for the agent and system. */
  authorId?: string
  /** Markdown. */
  body: string
  card?: Card
  toolTrace?: ChatToolUse[]
  costUsd?: number
  transcriptRef?: string
  /** Lowercased names after `@` in the body, e.g. `holtkeeper`. */
  mentions: string[]
  /** What the message refers to, in the order the writer gave; empty when nothing. */
  refs: ChatMessageRef[]
  createdAt: Timestamp
  /** When the card, body or refs were last changed in place. */
  updatedAt?: Timestamp
}

/** What `ChatStore.addMessage` takes; `refs` default to none. */
export type ChatMessageInput = Omit<ChatMessage, 'seq' | 'updatedAt' | 'refs'> &
  Partial<Pick<ChatMessage, 'refs'>>

/** One human author of a thread and how many messages they wrote. */
export interface ChatContextParticipant {
  /** Principal id. */
  id: string
  messages: number
}

/** Totals over every message of one thread, for its context column. */
export interface ChatThreadContext {
  messageCount: number
  /** Sum of the messages' `costUsd`; 0 when none has one. */
  costUsd: number
  /**
   * The thread's `contextRepos` in their order, then the repositories of message `refs` not among
   * them, in order of first mention; no duplicates.
   */
  repos: string[]
  /** Calls per tool summed over every `toolTrace`, most calls first, then by tool name. */
  tools: ChatToolUse[]
  /** Human authors in order of their first message. */
  participants: ChatContextParticipant[]
}

/** Which messages `ChatStore.listMessages` returns. */
export interface ChatMessageQuery {
  /** Only messages with a greater `seq`; the oldest of them first. */
  after?: number
  /** Only messages with a smaller `seq`; the newest of them, still returned oldest first. */
  before?: number
  /** Also messages changed in place at or after this time, whatever their `seq`. */
  changedSince?: Timestamp
  /** Default 50, at most 500. */
  limit?: number
}

/** How far one person has read one thread. */
export interface ChatThreadRead {
  threadId: string
  userId: string
  lastReadMessageId: string
  lastReadSeq: number
}

/** Team chat threads, their messages and how far each person has read them. */
export interface ChatStore {
  createThread(thread: ChatThreadInput): Promise<ChatThread>
  getThread(id: string): Promise<ChatThread | undefined>
  /** Threads that pass `filter` (see `ChatThreadFilter`), most recently updated first. */
  listThreads(filter?: ChatThreadFilter): Promise<ChatThread[]>
  /** Applies `patch`; `undefined` when the thread does not exist. */
  updateThread(id: string, patch: ChatThreadPatch): Promise<ChatThread | undefined>
  /** Stores a message with the next `seq` and moves the thread's `updatedAt` to its `createdAt`. */
  addMessage(message: ChatMessageInput): Promise<ChatMessage>
  getMessage(id: string): Promise<ChatMessage | undefined>
  /**
   * Replaces the card, body or refs of a message and stamps `updatedAt`; `undefined` when it is
   * gone.
   */
  updateMessage(
    id: string,
    patch: { card?: Card; body?: string; refs?: ChatMessageRef[]; updatedAt: Timestamp },
  ): Promise<ChatMessage | undefined>
  /** Messages of a thread, oldest first (see `ChatMessageQuery`). */
  listMessages(threadId: string, query?: ChatMessageQuery): Promise<ChatMessage[]>
  /** Moves the person's read marker to `messageId`; never backwards. No-op for unknown messages. */
  markRead(threadId: string, userId: string, messageId: string): Promise<void>
  /** The person's read markers. */
  reads(userId: string): Promise<ChatThreadRead[]>
  /**
   * Messages after the person's read marker that others wrote, per thread of `threadIds` with any;
   * a thread without a marker counts all of them.
   */
  unreadCounts(userId: string, threadIds: readonly string[]): Promise<Record<string, number>>
  /** Messages per thread of `threadIds` with any, counted without reading them. */
  messageCounts(threadIds: readonly string[]): Promise<Record<string, number>>
  /** Totals over the thread's messages (see `ChatThreadContext`); `undefined` for unknown threads. */
  context(threadId: string): Promise<ChatThreadContext | undefined>
  /** Mutes or unmutes the thread for one person; muting twice or unmuting an unmuted thread is a no-op. */
  setMuted(threadId: string, userId: string, muted: boolean): Promise<void>
  /** Ids of the threads the person muted, sorted. */
  mutedThreads(userId: string): Promise<string[]>
}

/** What an agent task does; it shapes the agent's instructions and where people see it. */
export type AgentTaskKind = 'fix' | 'port' | 'upgrade' | 'propagate-fix' | 'chat' | 'tests'

/**
 * Where an agent task stands: `proposed` until a person approves it, `approved` while its job is
 * being queued, `queued` and `running` on a write worker, `mr-open` once its merge request is open,
 * `done` when that merge request is merged or there was nothing to change, `failed` and
 * `cancelled` at the end.
 */
export type AgentTaskStatus =
  | 'proposed'
  | 'approved'
  | 'queued'
  | 'running'
  | 'mr-open'
  | 'done'
  | 'failed'
  | 'cancelled'

/** What asked for a task group. */
export type AgentTaskSource =
  | { type: 'chat'; threadId: string; messageId?: string }
  | { type: 'dependency-upgrade'; ecosystem: string; package: string; from?: string; to: string }
  | { type: 'propagate'; group?: string }
  | { type: 'mcp'; client?: string }
  | { type: 'api' }

/** CI of a task's merge request: the latest pipeline of its branch, as the forge reports it. */
export type AgentTaskCi = 'none' | 'pending' | 'running' | 'success' | 'failed' | 'canceled'

/** The merge request a task opened. */
export interface AgentTaskMergeRequest {
  id: number
  url: string
  draft: boolean
  state?: 'open' | 'merged' | 'closed'
  ci?: AgentTaskCi
  /** When state and CI were last read from the forge. */
  checkedAt?: Timestamp
  /** Files changed and lines added and removed by the merge request, read from the forge. */
  diffstat?: AgentTaskDiffstat
  /** The merge request's head commit `diffstat` was read at. */
  diffSha?: string
}

/** How big a change is: files touched, lines added and lines removed. */
export interface AgentTaskDiffstat {
  files: number
  additions: number
  deletions: number
}

/**
 * One repository's part of a task group: the change made in `repo`, the job that makes it and the
 * merge request it opened. Title, prompt and kind are the group's at creation time.
 */
export interface AgentTask {
  id: string
  groupId: string
  kind: AgentTaskKind
  title: string
  /** What the agent is asked to do. */
  prompt: string
  /** The plan people approved, when it differs from the prompt. */
  plan?: string
  /** A unified diff tried with `git apply -3` before any agent runs. */
  patch?: string
  /** `forge:path` of the repository the task changes. */
  repo: string
  /** Principal id the task works for: the proposer, and the approver once approved. */
  requester: string
  source: AgentTaskSource
  status: AgentTaskStatus
  /** The `write-task` job, once queued. */
  jobId?: string
  /** Spend cap of the job in USD. */
  budgetUsd?: number
  /** What the job's agent spent, in USD. */
  costUsd?: number
  /** Artifact key of the agent's transcript. */
  transcriptRef?: string
  mergeRequest?: AgentTaskMergeRequest
  /** Why the task failed or was cancelled. */
  error?: string
  createdAt: Timestamp
  updatedAt: Timestamp
}

/** A repository a running task asked to add to its group; a person decides. */
export interface AgentTaskRepoRequest {
  repo: string
  reason: string
  /** Task that asked. */
  taskId: string
  status: 'pending' | 'approved' | 'rejected'
  at: Timestamp
  decidedBy?: string
}

/**
 * One request to change code (one source, one or more target repositories): a task per
 * repository, all on the same branch. People approve or cancel the whole group; its status is
 * derived from its tasks (`agentGroupStatus`).
 */
export interface AgentTaskGroup {
  id: string
  kind: AgentTaskKind
  title: string
  prompt: string
  plan?: string
  patch?: string
  /** Principal id that proposed the group. */
  proposedBy: string
  /** Principal id that approved it; tasks then work for this person. */
  approvedBy?: string
  approvedAt?: Timestamp
  cancelledBy?: string
  source: AgentTaskSource
  /** `forge:path` of every target, in the order given. */
  repos: string[]
  /** Interactive work may use the AI budget reserve; automatic work may not. */
  budgetClass: 'interactive' | 'automatic'
  requests?: AgentTaskRepoRequest[]
  createdAt: Timestamp
  updatedAt: Timestamp
}

/** Which tasks `AgentTaskStore.list` returns. */
export interface AgentTaskFilter {
  groupIds?: readonly string[]
  repos?: readonly string[]
  status?: readonly AgentTaskStatus[]
  requester?: string
  /** Default: all. */
  limit?: number
}

/** Which groups `AgentTaskStore.listGroups` returns. */
export interface AgentTaskGroupFilter {
  sourceType?: AgentTaskSource['type']
  /** Groups with a target among these `forge:path` keys. */
  repos?: readonly string[]
  proposedBy?: string
  /** Default: all. */
  limit?: number
}

/** Agent tasks and their groups; newest `updatedAt` first, then by id. */
export interface AgentTaskStore {
  get(id: string): Promise<AgentTask | undefined>
  list(filter?: AgentTaskFilter): Promise<AgentTask[]>
  /** Inserts or replaces the task. */
  put(task: AgentTask): Promise<void>
  /**
   * Replaces the stored task only while its status is one of `from`, atomically; `false` when it
   * is missing or another writer changed its status first.
   */
  transition(task: AgentTask, from: readonly AgentTaskStatus[]): Promise<boolean>
  getGroup(id: string): Promise<AgentTaskGroup | undefined>
  listGroups(filter?: AgentTaskGroupFilter): Promise<AgentTaskGroup[]>
  /** Inserts or replaces the group. */
  putGroup(group: AgentTaskGroup): Promise<void>
}

/** Everything Holtkeeper persists. Implementations: in-memory, SQLite, Postgres. */
export interface Store {
  auditRuns: AuditRunStore
  analyses: AnalysisStore
  credentials: CredentialStore
  settings: SettingStore
  users: UserStore
  jobs: JobStore
  knowledge: KnowledgeStore
  guides: GuideStore
  families: FamilyStore
  learnings: LearningStore
  aiUsage: AiUsageStore
  ciJobs: CiJobStore
  chat: ChatStore
  /** Agent tasks (write tasks people or automation asked for) and their groups. */
  tasks: AgentTaskStore
  /** Panel-managed configuration; servers without it have no forges, groups or triggers. */
  config?: ConfigStore
  /** Small expiring state; servers without it keep such state in memory. */
  kv?: KvStore
  /** Tamper-evident audit log of who did what; Settings › Audit log reads it. */
  audit: AuditStore
  /** External accounts linked to principals; servers without it cannot link accounts. */
  externalAccounts?: ExternalAccountStore
  /** Third-party library docs; servers without it index no libraries. */
  libraries?: LibraryStore
  /** Introspection of the underlying database; stores without one (memory) leave it out. */
  database?: DatabaseInspector
  close(): Promise<void>
}
