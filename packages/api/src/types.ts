import type { Grant, Principal, Scope } from '@holtkeeper/access'
import type { AuthInfo } from '@holtkeeper/auth'
import type { Conflict } from '@holtkeeper/changes'
import type { RepoRef } from '@holtkeeper/forge'
import type { Metric, Report } from '@holtkeeper/report'
import type {
  ActivityEvent,
  AiUsageBucket,
  AiUsageDimension,
  AiUsageRecord,
  AiUsageTotals,
  AuditEvent,
  AuditRun,
  AuditTrigger,
  AuditVerification,
  ExternalVerification,
  ConfigDocumentType,
  ConfigRevision,
  GroupDocumentData,
  Job as StoredJob,
  KnowledgeEntry,
  KnowledgeKind,
  KnowledgeLink,
  KnowledgePackage,
  KnowledgeRevision,
  KnowledgeStatus,
  RegisteredWebhook,
  RepoTraitsDocumentData,
  RotationPolicy,
  ScheduleDocumentData,
  Timestamp,
  TriggerDocumentData,
} from '@holtkeeper/store'
import type { Severity } from '@holtkeeper/vuln'

/** Error body of every non-2xx JSON response. */
export interface ApiError {
  error: string
}

/** The caller with the URL of their generated avatar. */
export interface MePrincipal extends Principal {
  /** `/api/avatars/<seed>.svg`; the seed is the user's `avatarSeed` or the principal id. */
  avatarUrl: string
}

/** `GET /api/me` */
export interface MeResponse {
  principal: MePrincipal | null
  auth: AuthInfo
}

/** `PUT /api/me/avatar` — a new avatar seed (accounts of the `users` provider only); `null` resets it. */
export interface SetAvatarInput {
  seed: string | null
}

/** `GET /api/audit` — newest first; pass `nextCursor` as `cursor` for the next page. */
export interface AuditList {
  events: AuditEvent[]
  nextCursor?: string
}

/** `GET /api/audit/verify?fromSeq=&toSeq=` */
export type AuditVerifyResponse = AuditVerification

/** An external account linked to a principal; the challenge hash never leaves the server. */
export interface ExternalAccountView {
  id: string
  userId: string
  provider: string
  externalId: string
  username?: string
  verification: ExternalVerification
  linkedBy: string
  linkedAt: Timestamp
  verifiedAt?: Timestamp
  /** When the pending challenge code expires. */
  challengeExpiresAt?: Timestamp
}

/** `GET /api/accounts`, `GET /auth/users/admin/users/:id/accounts` */
export interface ExternalAccountList {
  accounts: ExternalAccountView[]
}

/** `POST /api/accounts`, `POST /auth/users/admin/users/:id/accounts` */
export interface LinkAccountInput {
  /** `gitlab:<forgeId>`, `github:<forgeId>`, `slack:<workspaceId>`, ... */
  provider: string
  /** Numeric user id for GitLab and GitHub. */
  externalId: string
  username?: string
}

/** `POST /api/accounts/:id/challenge` — shown once. */
export interface AccountChallenge {
  code: string
  expiresAt: Timestamp
  /** Post this as a merge request or issue comment, or send it to the bot. */
  command: string
}

export type SeverityCounts = Record<Severity, number>

/** Compact view of an audit run for lists, charts and dashboards. */
export interface AuditRunSummary {
  id: string
  repo: RepoRef
  trigger: AuditTrigger
  actor?: string
  startedAt: Timestamp
  finishedAt: Timestamp
  /** Active (not allowlisted, not fixed) findings by severity. */
  severities: SeverityCounts
  active: number
  ignored: number
  resolved: number
  expiredAllowlist: number
  /** Languages and package managers present among the findings, e.g. `JavaScript`, `pnpm`. */
  languages: string[]
  tools: string[]
  changedFiles: number
}

/** `GET /api/audit-runs` */
export interface AuditRunList {
  runs: AuditRunSummary[]
}

/** `GET /api/audit-runs/:id` */
export interface AuditRunDetail {
  run: AuditRun
  summary: AuditRunSummary
}

/** `POST /api/audit-runs` — ingests a report produced elsewhere (CLI, CI). */
export type IngestAuditRun = Omit<AuditRun, 'id' | 'actor'>

/** One repository Holtkeeper knows about, with its latest audit. */
export interface RepoSummary {
  repo: RepoRef
  groups: string[]
  latestAudit?: AuditRunSummary
}

/** `GET /api/repos` */
export interface RepoList {
  repos: RepoSummary[]
}

/** A credential without its secret. */
export interface CredentialView {
  id: string
  name: string
  kind: string
  url: string
  scope: Scope
  expiresAt?: Timestamp
  rotation?: RotationPolicy
  lastRotatedAt?: Timestamp
  lastError?: string
  /** Kind-specific, non-secret configuration, e.g. an AI provider's endpoint options. */
  options?: Record<string, unknown>
  createdAt: Timestamp
  updatedAt: Timestamp
}

/** `GET /api/credentials` */
export interface CredentialList {
  credentials: CredentialView[]
}

/** `POST /api/credentials` */
export interface CreateCredentialInput {
  name: string
  kind: string
  url: string
  scope: Scope
  secret: string
  expiresAt?: Timestamp
  rotation?: RotationPolicy
  /** Kind-specific configuration, stored unsealed; `{secret}` in header values refers to the secret. */
  options?: Record<string, unknown>
}

/**
 * `PATCH /api/credentials/:id`; a new `secret` replaces the stored one, new `options` replace the
 * stored ones and `{}` removes them.
 */
export type UpdateCredentialInput = Partial<CreateCredentialInput>

/** A stored setting; secret values are replaced by `null`. */
export interface SettingView {
  id: string
  key: string
  scope: Scope
  value: unknown
  secret: boolean
  updatedAt: Timestamp
  updatedBy?: string
}

/** A setting the server understands. `schema` is JSON Schema for building forms. */
export interface SettingDefinitionView {
  key: string
  label: string
  description: string
  section: string
  secret: boolean
  schema: unknown
}

/** `GET /api/settings` */
export interface SettingList {
  definitions: SettingDefinitionView[]
  settings: SettingView[]
}

/** `PUT /api/settings` — creates or, with `id`, replaces an entry. */
export interface PutSettingInput {
  id?: string
  key: string
  scope: Scope
  value: unknown
}

/** `GET /api/settings/resolve?repo=forge:path` — the winning entry per key. */
export interface ResolvedSettings {
  repo: RepoRef
  groups: string[]
  settings: Record<string, SettingView>
}

/** Compact view of an analysis record for lists. */
export interface AnalysisSummary {
  id: string
  repo: RepoRef
  kind: string
  label: string
  ref?: string
  createdAt: Timestamp
  actor?: string
  metrics: Metric[]
}

/** `GET /api/analyses?repo=&kind=&before=&limit=` */
export interface AnalysisList {
  analyses: AnalysisSummary[]
}

/** `GET /api/analyses/kinds` — analysis kinds the server understands. */
export interface AnalysisKindList {
  kinds: { kind: string; label: string }[]
}

/**
 * `GET /api/analyses/:id?compare=<id>` — the rendered report. It compares with `compare` when
 * given, otherwise with the previous record of the same kind and repository.
 */
export interface AnalysisDetail {
  analysis: AnalysisSummary
  previous?: AnalysisSummary
  report: Report
}

/** `POST /api/analyses/:id/changes` — accepts some of a report's proposed changes. */
export interface ApplyChangesInput {
  /** `CodeChange` ids from the report's `changes` blocks. */
  ids: string[]
  /** `patch` returns a unified diff; `merge-request` pushes a branch and opens a merge request. */
  mode: 'patch' | 'merge-request'
  /** Merge request title; the server picks one when omitted. */
  title?: string
}

/** Result of `POST /api/analyses/:id/changes`. Changes with conflicts are left out of the result. */
export interface ApplyChangesResult {
  applied: string[]
  conflicts: Conflict[]
  /** Unified diff of the applied changes, for `patch` mode. */
  patch?: string
  /** The opened merge request, for `merge-request` mode; the first one when there are several. */
  mergeRequest?: { id: number; url: string }
  /** Every opened merge request when changes targeted several repositories. */
  mergeRequests?: { id: number; url: string }[]
}

/** `POST /api/analyses` — `data` must match the kind's schema. */
export interface IngestAnalysis {
  repo: RepoRef
  kind: string
  ref?: string
  createdAt?: Timestamp
  data: unknown
  /**
   * Binary files the data's `write-binary` edits reference by `artifact`; each `id` must be the
   * SHA-256 (hex) of the decoded content.
   */
  artifacts?: { id: string; base64: string; contentType?: string; name?: string }[]
}

/** `GET /api/activity` */
export interface ActivityList {
  events: ActivityEvent[]
}

// Users (only with the `users` auth provider), under `/auth/users`.

export interface UserView {
  id: string
  name: string
  email?: string
  grants: Grant[]
  disabled: boolean
  createdAt: Timestamp
  createdBy?: string
  passkeys: { id: string; label?: string; createdAt: Timestamp; lastUsedAt?: Timestamp }[]
  identities: { provider: string; email?: string }[]
  avatarUrl: string
}

/** `GET /auth/users/admin/users` */
export interface UserList {
  users: UserView[]
}

/** `POST /auth/users/admin/users` — invites a user; grants must be within the inviter's. */
export interface InviteUserInput {
  name: string
  email?: string
  grants: Grant[]
}

/** A one-time link for setting up a passkey; shown once. */
export interface LinkResponse {
  user: UserView
  link: string
  expiresAt: Timestamp
}

/** `PATCH /auth/users/admin/users/:id` */
export interface UpdateUserInput {
  name?: string
  email?: string
  grants?: Grant[]
  disabled?: boolean
}

/** `GET /auth/users/link/:token` — what a setup or recovery link is for. */
export interface LinkInfo {
  purpose: 'enroll' | 'recover'
  userName: string
  expiresAt: Timestamp
}

/** `GET /api/jobs/:id` — a background analysis run, with its last log lines. */
export type Job = StoredJob

/** A job without its log, for lists. */
export type JobSummary = Omit<StoredJob, 'log'>

/** `GET /api/jobs?status=&repo=&limit=&before=` — newest first, only repositories the caller may read. */
export interface JobList {
  jobs: JobSummary[]
}

/**
 * `POST /api/jobs` — queues an analyzer run. Repo-scope analyzers take `repo` (`forge:path`),
 * group-scope analyzers take `group`. `options` must match the analyzer's options.
 */
export interface CreateJobInput {
  analyzer: string
  repo?: string
  group?: string
  ref?: string
  options?: Record<string, unknown>
}

/** A knowledge entry; `score` is set on search results (higher is more relevant). */
export interface KnowledgeEntryView extends KnowledgeEntry {
  score?: number
}

/**
 * `GET /api/knowledge?status=&kind=&topic=&package=&scope=&q=&repo=&limit=` — `status` and `kind`
 * take comma lists. With `q`, best matches first; otherwise most recently updated first. With
 * `repo` (`forge:path`), every entry whose scope covers the repository; otherwise only entries
 * whose scope the caller may read.
 */
export interface KnowledgeList {
  entries: KnowledgeEntryView[]
}

/** `GET /api/knowledge/:id` — the entry with its previous versions, newest first. */
export interface KnowledgeDetail {
  entry: KnowledgeEntry
  history: KnowledgeRevision[]
}

/**
 * `POST /api/knowledge` — a person's entry; `status` defaults to `accepted`. A `migration` must
 * name its packages, the scope must cover something and `appliesTo` must not be empty.
 */
export interface CreateKnowledgeInput {
  title: string
  body: string
  kind: KnowledgeKind
  scope: Scope
  topics?: string[]
  appliesTo: string[]
  packages?: KnowledgePackage[]
  evidence?: KnowledgeLink[]
  supersedes?: string
  status?: KnowledgeStatus
}

/**
 * `PUT /api/knowledge/:id` — replaces the content and bumps the version. With `version`, the
 * update fails with 409 when the entry changed since.
 */
export interface UpdateKnowledgeInput extends CreateKnowledgeInput {
  version?: number
}

/** `POST /api/artifacts/zip` — downloads stored artifacts as one ZIP archive. */
export interface ArtifactZipInput {
  files: { id: string; path: string }[]
  /** Download file name. Default `artifacts.zip`. */
  name?: string
}

/** `POST /api/media/variants` — generates responsive variants of an image in a repository. */
export interface MediaVariantsInput {
  /** `forge:path`. */
  repo: string
  file: string
  /** Branch, tag or commit; the default branch when omitted. */
  ref?: string
  formats?: string[]
  widths?: number[]
  densities?: number[]
  quality?: number
  preset?: string
}

/** One generated variant, stored as an artifact (`GET /api/artifacts/:id`). */
export interface MediaVariantView {
  id: string
  format: string
  width: number
  height: number
  quality: number
  bytes: number
  /** Compared with the original; negative when the variant is larger. */
  savingsPercent: number
  /** Suggested repository path. */
  path: string
}

/** Size comparison of the variants with the original, ready for a table. */
export interface MediaSavings {
  originalBytes: number
  /** Smallest variant of each format at the largest width generated for it. */
  formats: { format: string; width: number; bytes: number; savingsPercent: number }[]
  bestFormat?: string
  bestSavingsPercent: number
}

/** Result of `POST /api/media/variants`. */
export interface MediaVariantsResult {
  original: { bytes: number; width: number; height: number; format: string; sha256: string }
  variants: MediaVariantView[]
  /** For SVG originals: the optimized file, stored as an artifact. */
  svg?: { id: string; before: number; after: number; breakdown: Record<string, number> }
  /** Markup per framework (`html`, `react`, ...). */
  snippets: Record<string, string>
  savings: MediaSavings
}

/** `POST /api/media/apply` — puts generated files into the repository or a ZIP download. */
export interface MediaApplyInput {
  repo: string
  file: string
  /** Branch the merge request targets; the default branch when omitted. */
  ref?: string
  /** Artifact ids of variants to add. */
  variants: string[]
  /** Repository path per artifact id; default the path suggested when the variant was made. */
  paths?: Record<string, string>
  /** Artifact id whose content replaces `file` itself (e.g. the optimized SVG). */
  replaceOriginal?: string
  /** A text replacement that switches markup to the variants. */
  snippet?: {
    file: string
    range: { start: { line: number; column: number }; end: { line: number; column: number } }
    oldText: string
    newText: string
  }
  /** `zip` answers with an `application/zip` download instead of JSON. */
  mode: 'merge-request' | 'zip'
  title?: string
}

/** Result of `POST /api/media/apply` in `merge-request` mode. */
export interface MediaApplyResult {
  applied: boolean
  conflicts: Conflict[]
  mergeRequest?: { id: number; url: string }
}

/** One line of a storage breakdown. */
export interface StorageDetailView {
  label: string
  bytes: number
  count?: number
}

/** One storage area in `GET /api/storage`. */
export interface StorageProviderView {
  id: string
  label: string
  bytes: number
  count?: number
  details: StorageDetailView[]
  /** `false` when the area is not used in this setup (e.g. no container execution). */
  available: boolean
  note?: string
  /** Whether `POST /api/storage/:id/clear` works for it. */
  clearable: boolean
  /** Set when measuring failed. */
  error?: string
}

/** `GET /api/storage` */
export interface StorageOverview {
  providers: StorageProviderView[]
  totalBytes: number
}

/** `POST /api/storage/:id/clear` — `scope` narrows what is removed, as the provider documents. */
export interface ClearStorageInput {
  scope?: string
}

/** Result of `POST /api/storage/:id/clear`. */
export interface ClearStorageResult {
  removed?: number
  bytes?: number
}

/** `GET /api/ai/usage`: aggregate buckets and their totals over the same records. */
export interface AiUsageBuckets {
  from?: Timestamp
  to?: Timestamp
  groupBy: AiUsageDimension[]
  buckets: AiUsageBucket[]
  /** Sums without grouping; with `group` in `groupBy` buckets may add up to more than this. */
  totals: AiUsageTotals
}

/** `GET /api/ai/runs`: individual runs, newest first. `jobId` / `analysisId` link to their pages. */
export interface AiRunList {
  runs: AiUsageRecord[]
  /** Pass as `before` for the next page; absent on the last one. */
  next?: Timestamp
}

/** One limit of a budget in the current period. */
export interface AiBudgetLimitView {
  period: 'day' | 'month'
  taskKind?: string
  limitUsd: number
  spentUsd: number
  percent: number
  /** Linear projection to the end of the month; monthly limits only. */
  projectedUsd?: number
}

/** An `llm.budget` setting and how much of it is used. */
export interface AiBudgetStatus {
  /** Setting entry id. */
  id: string
  scope: Scope
  action: 'warn' | 'block'
  limits: AiBudgetLimitView[]
}

/** Totals of one calendar month (UTC). */
export interface AiUsagePeriod {
  /** `YYYY-MM` */
  key: string
  from: Timestamp
  to: Timestamp
  totals: AiUsageTotals
}

/** `GET /api/ai/overview`: this month at a glance, limited to what the caller may see. */
export interface AiUsageOverview {
  month: AiUsagePeriod
  previousMonth: AiUsagePeriod
  /** This month, most expensive first, at most 5 each. */
  topRepos: AiUsageBucket[]
  topModels: AiUsageBucket[]
  topTaskKinds: AiUsageBucket[]
  /** Budgets whose scope the caller may read. */
  budgets: AiBudgetStatus[]
  /** This month's cache read tokens over all input tokens (fresh, cache read and cache write); 0 without input. */
  cacheHitRatio: number
  /** This month's failed runs over runs that were not denied; 0 without runs. */
  errorRate: number
}

/** Where a config entry comes from: the config file, the panel, or a panel override of a file entry. */
export type ConfigProvenance = 'file' | 'panel' | 'file+panel'

/** A forge as the panel shows it; the webhook secret is never included. */
export interface ForgeConfigView {
  kind: string
  url: string
  /** Panel forges only. */
  credentialId?: string
  webhook?: {
    /** Where the forge sends events: `${publicUrl}/api/webhooks/<forgeId>`. */
    url: string
    createdAt: Timestamp
    registered?: RegisteredWebhook[]
  }
}

/** The data each config collection holds. */
export interface ConfigViewData {
  forge: ForgeConfigView
  group: GroupDocumentData
  repoTraits: RepoTraitsDocumentData
  schedule: ScheduleDocumentData
  trigger: TriggerDocumentData
}

/**
 * One entry of the effective config. `version`, `updatedAt` and `updatedBy` are set when a panel
 * document exists for it; `data` is the effective value.
 */
export interface ConfigEntryView<T extends ConfigDocumentType = ConfigDocumentType> {
  type: T
  id: string
  provenance: ConfigProvenance
  data: ConfigViewData[T]
  version?: number
  updatedAt?: Timestamp
  updatedBy?: string
}

/** `GET /api/config/<collection>`; collections: `forges`, `groups`, `repo-traits`, `schedules`, `triggers`. */
export interface ConfigEntryList<T extends ConfigDocumentType = ConfigDocumentType> {
  entries: ConfigEntryView<T>[]
}

/** `GET /api/config/<collection>/:id`: the entry and the panel document's earlier versions. */
export interface ConfigEntryDetail<T extends ConfigDocumentType = ConfigDocumentType> {
  entry: ConfigEntryView<T>
  history: ConfigRevision<T>[]
}

/** Bodies of `PUT /api/config/<collection>/:id`. */
export interface PutConfigInput {
  forge: { kind: 'gitlab' | 'github'; url: string; credentialId: string }
  group: { forge: string; include: string[]; exclude?: string[] }
  repoTraits: {
    pattern: string
    forge?: string
    traits?: Record<string, string | number | boolean>
  }
  schedule: Omit<ScheduleDocumentData, 'enabled'> & { enabled?: boolean }
  trigger: TriggerDocumentData
}

/**
 * `POST /api/forges/:id/webhook`: generates (or rotates) the forge's webhook secret. With
 * `register`, the hook is (re-)registered on each target (default: every group of the forge).
 */
export interface ForgeWebhookInput {
  register?: boolean
  targets?: { group?: string; project?: string }[]
}

/** Result of `POST /api/forges/:id/webhook`. `secret` is shown only in this response. */
export interface ForgeWebhookResult {
  url: string
  secret: string
  registered: RegisteredWebhook[]
  /** Targets that fell back to project hooks, and why. */
  notes: string[]
  /** Targets that could not be registered. */
  errors: { target: string; error: string }[]
}

/** `GET /api/schedules/:id/preview?count=10`: upcoming run times. */
export interface SchedulePreview {
  id: string
  timezone: string
  runs: Timestamp[]
}
