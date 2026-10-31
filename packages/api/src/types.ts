import type { Grant, GroupMatch, Principal, Scope } from '@holtkeeper/access'
import type { ApiPackage, ApiSymbol, PackageDiff } from '@holtkeeper/api-surface'
import type { AuthInfo } from '@holtkeeper/auth'
import type { Conflict } from '@holtkeeper/changes'
import type { FleetLibrary } from '@holtkeeper/depgraph'
import type { RepoRef, SshKeyUsage } from '@holtkeeper/forge'
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
  LibraryChunk,
  DatabaseDomain,
  DatabaseIndex,
  DatabaseMigration,
  DatabaseOverview,
  DatabaseSession,
  DatabaseTable,
  LibraryEcosystem,
  LibraryRecord,
  LibraryVersionRecord,
  RegisteredWebhook,
  RepoTraitsDocumentData,
  RotationPolicy,
  ScheduleDocumentData,
  Timestamp,
  TriggerDocumentData,
} from '@holtkeeper/store'
import type {
  FleetExport,
  FoundSite,
  TypeResolution,
  UpgradeImpact,
  UsedExport,
} from '@holtkeeper/usages'
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
  /** The newest record of each analysis kind, when the caller may read analyses. */
  latestAnalyses?: AnalysisSummary[]
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
  /** Whether the server can issue a new token for this kind (`POST /api/credentials/:id/rotate`). */
  rotatable: boolean
  /** Kind-specific, non-secret configuration, e.g. an AI provider's endpoint options. */
  options?: Record<string, unknown>
  createdAt: Timestamp
  updatedAt: Timestamp
}

/** One model an AI provider offers; prices in USD per million tokens. */
export interface ProviderModelView {
  id: string
  name?: string
  createdAt?: Timestamp
  pricing?: {
    inputPerMTok: number
    outputPerMTok: number
    cacheReadPerMTok?: number
    cacheWritePerMTok?: number
  }
  /** Whether the model calls tools, when the catalog says; agents need it. */
  toolCall?: boolean
  contextWindow?: number
  /**
   * `provider`: listed by the provider's API; `catalog`: from the AI catalog; `config`: only named in
   * the credential's options.
   */
  source: 'provider' | 'catalog' | 'config'
}

/** A provider of the AI catalog (models.dev) that `ai-sdk` credentials can use. */
export interface AiCatalogProviderView {
  id: string
  name: string
  /** AI SDK package Holtkeeper talks to it with. */
  package: string
  /** API root of OpenAI-compatible providers. */
  api?: string
  doc?: string
  /** Environment variables its key usually lives in, e.g. `OPENROUTER_API_KEY`. */
  env: string[]
  /** Models that call tools, which agents can use. */
  toolModels: number
}

/** `GET /api/ai/providers` — `error` when the catalog could not be loaded. */
export interface AiCatalogProviderList {
  providers: AiCatalogProviderView[]
  /** AI SDK packages a provider of your own can use. */
  packages: string[]
  error?: string
}

/** `POST /api/credentials/:id/test` — asks an `ai-sdk` provider's model for a one-word reply. */
export interface CredentialTestInput {
  /** Default: the credential's `model` option. */
  model?: string
}

export interface CredentialTestResult {
  ok: boolean
  model: string
  reply?: string
  latencyMs?: number
  error?: string
}

/** `GET /api/credentials/:id/models` — `error` when the provider's API could not be asked. */
export interface ProviderModelList {
  models: ProviderModelView[]
  error?: string
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
  /** Markdown guidance for editors: what the setting changes and recommended values. */
  help?: string
  /** Ready-made values; applied to an object value, a preset sets its fields and keeps the others. */
  presets?: SettingPresetView[]
}

/** A named value of a setting the editor offers as a starting point. */
export interface SettingPresetView {
  id: string
  label: string
  description?: string
  value: unknown
}

/** `GET /api/settings` */
export interface SettingList {
  definitions: SettingDefinitionView[]
  settings: SettingView[]
  /** Users among the entries' `updatedBy`, by id; other ids (`system`, services) are absent. */
  people: Record<string, ActivityPerson>
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
  /** Names and avatars of the users among the records' actors. */
  people: Record<string, ActivityPerson>
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

/** A repository in the dependency inventory and the record its dependencies come from. */
export interface DependencyRepo {
  repo: RepoRef
  analysisId: string
  ref?: string
  createdAt: Timestamp
  /** Direct dependencies across its workspaces. */
  dependencies: number
}

/**
 * `GET /api/dependencies` — direct dependencies of every repository the caller may read, from the
 * newest `depgraph` analysis of each. Usages and sources identify repositories as `forge:path`.
 */
export interface DependencyInventory {
  repos: DependencyRepo[]
  libraries: FleetLibrary<string>[]
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

/** A user an activity event names as actor or subject. */
export interface ActivityPerson {
  name: string
  avatarUrl: string
}

/** `GET /api/activity` */
export interface ActivityList {
  events: ActivityEvent[]
  /** Users among the events' actors and subjects, by id; other ids (services, repos) are absent. */
  people: Record<string, ActivityPerson>
}

// Users (only with the `users` auth provider), under `/auth/users`.

/** A user; `GET /auth/users/me` returns the caller's own. */
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

/**
 * `GET /api/jobs?status=&repo=&analyzer=&schedule=&limit=&before=` — newest first, only
 * repositories the caller may read.
 */
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

/**
 * `POST /api/releases/backfill`: analyze past releases. Answers 202 at once; repositories are
 * walked in the background and the outcome is logged as a `releases.backfill` activity entry. Without `repo` or `group` it covers every
 * repository of every group. `limit` newest releases per repository (default 20, at most 100); a
 * release is a plain tag or a commit carrying monorepo package tags (`@scope/name@1.2.3`).
 */
export interface ReleaseBackfillInput {
  repo?: string
  group?: string
  limit?: number
  /** Also queue `release-risk` for each release after its changelog; each analyzer skips the releases it has analyzed. */
  risk?: boolean
  /** Also queue `api-surface` for each release, so every version's public API is kept. */
  api?: boolean
}

/** Answer to a release backfill, which goes on in the background. */
export interface ReleaseBackfillStarted {
  startedAt: string
}

/** What a release backfill queued; the details of its `releases.backfill` activity entry. */
export interface ReleaseBackfillResult {
  repos: number
  /** Releases found across the repositories: plain tags and commits carrying package tags. */
  tags: number
  queued: number
  /** Jobs not queued: that analyzer already analyzed the release, or a job is waiting or running. */
  skipped: number
  errors: { repo?: RepoRef; error: string }[]
}

/** An analyzer jobs can run. `schema` is JSON Schema of its options, for building forms. */
export interface JobAnalyzerView {
  kind: string
  label: string
  /** `repo`: queued per repository; `group`: once per config group. */
  scope: 'repo' | 'group'
  needs: { checkout?: boolean; forge?: boolean; agent?: 'required' | 'optional'; history?: boolean }
  schema: unknown
  presets?: SettingPresetView[]
}

/** `GET /api/jobs/analyzers` — `enabled` is false when the config has no `jobs` section. */
export interface JobAnalyzerList {
  enabled: boolean
  analyzers: JobAnalyzerView[]
}

/** `GET /api/repos/explain?repo=forge:path` — what the config applies to one repository. */
export interface RepoExplain {
  repo: RepoRef
  groups: string[]
  traits: Record<string, string | number | boolean>
  /** Plugins with their final options; options are omitted when the caller cannot read settings. */
  plugins: { name: string; options?: unknown }[]
  /** Schedules and triggers that queue jobs for the repository. */
  schedules: { name: string; title?: string; analyzers: string[] }[]
  triggers: { id: string; analyzers: string[] }[]
}

/**
 * A request an egress proxy changes: to `host` (exact, or `*.example.com`), with a path matching
 * one of `paths` (regular expressions; none: every path) and a method in `methods` (default `GET`
 * and `HEAD`; `*` for any), over TLS unless `insecure`. A rule has `headers`, `replace` or both.
 */
export interface EgressRule {
  host: string
  paths?: string[]
  methods?: string[]
  /** Set on matching requests, replacing what the client sent. The first matching rule sets them. */
  headers?: Record<string, string>
  /**
   * Placeholder to real value: every occurrence of a placeholder in the parts named by `in` is
   * replaced. Every matching rule applies its replacements.
   */
  replace?: Record<string, string>
  /** Where `replace` looks; default `headers`. `url` is the path with its query. */
  in?: ('headers' | 'url' | 'body')[]
  insecure?: boolean
}

/**
 * `GET /api/egress/rules` with `Authorization: Bearer <server.egress.secret>`: the rules for the
 * panel GitLab forges (all but those with `packages: false`), carrying their credential's current
 * token, and one replacement rule per host of every `egress-secret` credential. Never cache it
 * longer than a minute: rotation revokes the previous token at once. `cache` lists the private
 * cache rules of forges with `cachePackages`: their package files, downloaded with the token.
 */
export interface EgressRulesResponse {
  rules: EgressRule[]
  cache?: EgressCacheRule[]
}

/** What an egress proxy caches: package archives or tool downloads, each with its own TTL. */
export type EgressCacheKind = 'packages' | 'tools'

/** One cached download. `expiresAt` moves forward with every use. */
export interface EgressCacheEntry {
  /** Stable id of the entry inside the cache, used to delete it. */
  path: string
  url: string
  kind: EgressCacheKind
  size: number
  /** Served from the cache, counted approximately when several proxy replicas share it. */
  hits: number
  storedAt: Timestamp
  lastUsedAt: Timestamp
  expiresAt: Timestamp
  /** Past its TTL and waiting for the next sweep; requests already go upstream. */
  expired: boolean
}

/** A URL pattern the proxy caches. `private` entries may hold downloads that needed credentials. */
export interface EgressCacheRule {
  kind: EgressCacheKind
  host: string
  paths: string[]
  private: boolean
}

/**
 * `GET /api/egress/cache` — the download cache of the egress proxy, as one replica reports it.
 * `configured: false` when the config names no proxy (`server.egress.proxy`); `error` when it
 * could not be reached or has caching off.
 */
export type EgressCacheView =
  | { configured: false }
  | { configured: true; error: string }
  | {
      configured: true
      backend: { kind: 'dir' | 's3'; location: string }
      ttlSeconds: Record<EgressCacheKind, number>
      /** Least recently used entries go first above it; `null`: only TTLs limit the cache. */
      maxBytes: number | null
      maxEntryBytes: number
      /** When the replica that answered started counting `stats`. */
      since: Timestamp
      syncedAt: Timestamp | null
      stats: { hits: number; misses: number; stored: number; servedBytes: number; errors: number }
      rules: EgressCacheRule[]
      total: { count: number; bytes: number }
      /** Most recently used first, at most 5000. */
      entries: EgressCacheEntry[]
    }

/** `POST /api/egress/cache/delete` — given `paths`, a whole `kind`, or neither for everything. */
export interface DeleteEgressCacheInput {
  paths?: string[]
  kind?: EgressCacheKind
}

/** Result of `POST /api/egress/cache/delete`. */
export interface DeleteEgressCacheResult {
  removed: number
  bytes: number
}

/**
 * `GET /api/config/runtime` — the parts of the config only the file sets, without secrets: job
 * execution, server storage, limits, AI provider plugins and plugin uses.
 */
export interface RuntimeConfigView {
  dryRun: boolean
  jobs?: {
    concurrency: number
    timeoutMinutes: number
    cacheDir: string
    botUsername?: string
    execution?: {
      mode: 'host' | 'mise' | 'container'
      image?: string
      engine?: 'docker' | 'podman'
      network?: 'none' | 'install' | 'full'
      limits?: { cpus?: number; memory?: string; pids?: number }
      user?: string
      /** The egress proxy's `host:port`; credentials in its URL are never shown. */
      egress?: { proxy: string; ca: boolean }
    }
    schedules: number
  }
  server?: {
    publicUrl?: string
    rotationIntervalMinutes: number
    artifacts:
      | { kind: 'fs'; dir: string }
      | { kind: 's3'; bucket: string; endpoint?: string; region?: string; prefix?: string }
    retention?: { days?: number; maxBytes?: number }
  }
  limits: { distributed: boolean }
  aiProviders: string[]
  plugins: { name: string; groups: GroupMatch[]; exclude: string[]; overrides: string[] }[]
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
  /**
   * For areas on worker disks (git mirrors, tool caches): how many workers reported them in the
   * last 15 minutes. `details` then lists the workers, and clearing asks each to clear its copy.
   */
  reportedBy?: number
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

/**
 * Result of `POST /api/storage/:id/clear`. For areas workers report, `requested` is how many
 * workers were asked to clear their copy; they do so within seconds and report again.
 */
export interface ClearStorageResult {
  removed?: number
  bytes?: number
  requested?: number
}

/** Bytes and rows of one `DatabaseDomain`, now and as recorded about a week ago. */
export interface DatabaseDomainView {
  domain: DatabaseDomain
  tables: number
  rows: number
  bytes: number
  /** From the daily snapshot closest to seven days ago; missing without one. */
  weekAgoBytes?: number
}

/** One day of `DatabaseView.history`: the database and each domain at the snapshot. */
export interface DatabaseHistoryPoint {
  /** `YYYY-MM-DD`, UTC. */
  day: string
  bytes: number
  domains: Partial<Record<DatabaseDomain, number>>
}

/** What a `DatabaseAdvice` is about. */
export type DatabaseAdviceKind =
  | 'unused-index'
  | 'duplicate-index'
  | 'dead-rows'
  | 'stale-analyze'
  | 'seq-scans'
  | 'connections'
  | 'idle-in-transaction'
  | 'cache'
  | 'replication'
  | 'free-space'
  | 'statements'

/** A finding about the database worth a look, with the object it is about. */
export interface DatabaseAdvice {
  kind: DatabaseAdviceKind
  severity: 'info' | 'warning'
  /** Table, index, replica or `database`. */
  subject: string
  message: string
}

/** Annotations of an index in `DatabaseView.indexes`. */
export interface DatabaseIndexView extends DatabaseIndex {
  /** Never scanned since statistics were reset, and not backing a constraint. */
  unused: boolean
  /** Name of an earlier index on the same columns, when this one repeats it. */
  duplicateOf?: string
}

/** `GET /api/database`: everything but statements and sessions, which have their own routes. */
export type DatabaseView =
  | { available: false; reason: string }
  | {
      available: true
      overview: DatabaseOverview
      tables: (DatabaseTable & { domain: DatabaseDomain })[]
      indexes: DatabaseIndexView[]
      domains: DatabaseDomainView[]
      history: DatabaseHistoryPoint[]
      advice: DatabaseAdvice[]
      migrations: DatabaseMigration[]
      /** Whether `POST /api/database/queries/reset` is offered. */
      resettable: boolean
    }

/** `GET /api/database/sessions` */
export interface DatabaseSessionsView {
  sessions: DatabaseSession[]
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
  /** Panel forges: jobs read its package registries with its token, through the egress proxy. */
  packages?: boolean
  /** Panel forges: the egress proxy caches the package files jobs download from it. */
  cachePackages?: boolean
  webhook?: {
    /** Where the forge sends events: `${publicUrl}/api/webhooks/<forgeId>`. */
    url: string
    createdAt: Timestamp
    registered?: RegisteredWebhook[]
  }
  sshKey?: ForgeSshKeyView
}

/**
 * The SSH key a panel forge issued on its token's account. The private half never leaves the
 * server; `credentialId` is the `ssh` credential that holds it.
 */
export interface ForgeSshKeyView {
  credentialId: string
  createdAt: Timestamp
  publicKey: string
  fingerprint: string
  usage: SshKeyUsage
  expiresAt?: Timestamp
  /** Author of signed commits; absent when the account has no email to sign with. */
  identity?: { name: string; email: string }
  /** Whether the forge's SSH host keys are pinned; git over SSH needs them. */
  hostKeysPinned: boolean
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
  forge: {
    kind: 'gitlab' | 'github'
    url: string
    credentialId: string
    packages?: boolean
    cachePackages?: boolean
  }
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

/**
 * `POST /api/forges/:id/ssh-key`: issues an SSH key on the account behind the forge's token, or
 * rotates the one it has. Rotation keeps the key's usage and identity unless given here.
 */
export interface ForgeSshKeyInput {
  /** Default `auth_and_signing`. */
  usage?: SshKeyUsage
  /** Days until the forge stops accepting the key. Default 365. */
  expiresInDays?: number
  /** Overrides the commit identity read from the forge account. */
  identity?: { name: string; email: string }
}

/** Result of `POST /api/forges/:id/ssh-key`. */
export interface ForgeSshKeyResult {
  sshKey: ForgeSshKeyView
  /** What did not fully work, e.g. host keys that could not be scanned. */
  notes: string[]
}

/** `GET /api/schedules/:id/preview?count=10`: upcoming run times. */
export interface SchedulePreview {
  id: string
  timezone: string
  runs: Timestamp[]
}

/**
 * `GET /api/repos/avatar/info?repo=`: where the avatar at `GET /api/repos/avatar?repo=` comes from:
 * uploaded in the panel, the forge's (the project's or its group's), or generated from the path.
 */
export interface RepoAvatarInfo {
  source: 'custom' | 'forge' | 'generated'
  updatedAt?: Timestamp
  updatedBy?: string
}

/** One run of a schedule: the jobs it queued at one moment and how they are doing. */
export interface ScheduleRun {
  /** When the run queued its jobs. */
  at: Timestamp
  /** Who started it by hand; absent for timed runs. */
  actor?: string
  jobs: number
  queued: number
  running: number
  succeeded: number
  failed: number
  canceled: number
  analyzers: string[]
  /** First job start and, once nothing is queued or running, last job end. */
  startedAt?: Timestamp
  finishedAt?: Timestamp
  /** Up to five failed jobs. */
  failures: { id: string; analyzer: string; repo: RepoRef; error?: string }[]
}

/** `GET /api/schedules/runs?limit=10`: recent runs of every schedule, newest first. */
export interface ScheduleRunList {
  schedules: { id: string; runs: ScheduleRun[] }[]
}

/**
 * `POST /api/schedules/:id/run` answers 202 at once; listing repositories and queueing goes on in
 * the background and ends in a `schedule.run` activity entry with `ScheduleRunResult` details.
 */
export interface ScheduleRunStarted {
  id: string
  startedAt: string
}

/** Details of a `schedule.run` activity entry: what a manual run queued, or why it failed. */
export interface ScheduleRunResult {
  queued: number
  /** Jobs left out because the same analyzer already waits or runs for that repository. */
  skipped: number
  error?: string
}

/** How one repository learns about forge changes. */
export interface RepoUpdatesView {
  repo: RepoRef
  polling: {
    /** From the `polling` setting that applies to the repository. */
    enabled: boolean
    intervalMs: number
    events: ('mergeRequests' | 'notes' | 'pipelines' | 'tags' | 'pushes')[]
    /** Interval while webhooks reach the repository; absent when polling stops then. */
    withWebhookMs?: number
    /** Interval in effect after the webhook fallback and the credential's polling budget. */
    effectiveIntervalMs?: number
    /** How much the credential's budget slowed polling down; 1 when it did not. */
    stretch?: number
    /** Limiter key the polls draw from. */
    key: string
    lastPolledAt?: Timestamp
    nextAt?: Timestamp
    lastError?: string
    lastEvents?: number
    lastRequests?: number
    /** Recent polls, newest first. */
    attempts: PollAttemptView[]
  }
  /** Last webhook delivery about the repository through any webhook URL. */
  webhookSeenAt?: Timestamp
  /** Whether webhooks currently stand in for regular polling. */
  viaWebhook: boolean
  /** The repository's own webhook; absent until one is generated. */
  webhook?: {
    /** Contains the secret token; shown to callers who may change settings of the repository. */
    url?: string
    createdAt: Timestamp
    registered?: RegisteredWebhook[]
    lastDelivery?: { at: Timestamp; event: string; enqueued: number; ignored?: string }
  }
  /** Whether the forge can register the webhook itself. */
  canRegister: boolean
}

/** One poll of a repository: on its schedule or started by a person. */
export interface PollAttemptView {
  at: Timestamp
  trigger: 'scheduled' | 'manual'
  durationMs: number
  /** Changes found. */
  events?: number
  /** Jobs the changes queued. */
  enqueued?: number
  requests?: number
  error?: string
}

/** One listing of a group's repositories on its forge. */
export interface ListingAttemptView {
  at: Timestamp
  trigger: 'scheduled' | 'manual'
  durationMs: number
  /** Repositories found; absent when the listing failed. */
  repos?: number
  error?: string
}

/** `GET /api/repos/updates/groups/:group`: the repositories polling knows for a group. */
export interface GroupListingView {
  group: string
  forge: string
  /** From the last successful listing; kept when a later one fails. */
  repos: RepoRef[]
  listedAt?: Timestamp
  /** Newest first. */
  attempts: ListingAttemptView[]
}

/** `POST /api/repos/updates/webhook`: issues (or rotates) the repository's webhook URL. */
export interface RepoWebhookInput {
  repo: string
  /** Also create or update the hook on the forge. Default: when it was registered before. */
  register?: boolean
}

/** Result of `POST /api/repos/updates/poll`. */
export interface RepoPollResult {
  events?: number
  enqueued?: number
  error?: string
  skipped?: string
}

/** A package as the newest `api-surface` record of its repository describes it. */
export interface PublicApiPackageSummary {
  name: string
  version?: string
  description?: string
  private: boolean
  repo: RepoRef
  /** Folder of the package in the repository. */
  dir: string
  /** Release the record describes; absent for a default branch run. */
  ref?: string
  analysisId: string
  analyzedAt: Timestamp
  /** Entry point subpaths, `.` first. */
  subpaths: string[]
  exports: number
  documented: number
  deprecated: number
  /** Versions on record: one per released version, plus the default branch. */
  versions: number
}

/** `GET /api/api-surface/packages`. */
export interface PublicApiPackageList {
  packages: PublicApiPackageSummary[]
  /** When the server last read every record; versions backfilled since then may be missing. */
  indexedAt?: Timestamp
}

/** One recorded version of a package. */
export interface PublicApiVersion {
  /** The package's `version`, or the ref when it has none. */
  version: string
  /** Release the record describes; absent for the default branch. */
  ref?: string
  /** The newest default branch run, which may hold unreleased changes. */
  head: boolean
  analysisId: string
  analyzedAt: Timestamp
  exports: number
}

/** `GET /api/api-surface/package?name=&version=&repo=`: one version of a package in full. */
export interface PublicApiPackageDetail {
  repo: RepoRef
  ref?: string
  analysisId: string
  analyzedAt: Timestamp
  package: ApiPackage
  /** Newest first. */
  versions: PublicApiVersion[]
  /** Other repositories that have a package of the same name. */
  alsoIn: RepoRef[]
}

/** `GET /api/api-surface/diff?name=&from=&to=&repo=`. */
export interface PublicApiDiff {
  repo: RepoRef
  from: PublicApiVersion
  to: PublicApiVersion
  diff: PackageDiff
}

/** One hit of `GET /api/api-surface/search`. */
export interface PublicApiSymbolHit {
  package: string
  version?: string
  repo: RepoRef
  subpath: string
  /** What code imports it from, e.g. `@acme/ui/button`. */
  importPath: string
  symbol: ApiSymbol
}

/** `GET /api/api-surface/search?q=&package=&kind=&limit=`. */
export interface PublicApiSearchResult {
  hits: PublicApiSymbolHit[]
  /** Matches beyond `limit`. */
  more: number
}

/** How one repository uses a package, from its newest `usages` record. */
export interface PackageUsageRepo {
  repo: RepoRef
  analysisId: string
  analyzedAt: Timestamp
  ref?: string
  /** Versions the lockfile resolves, highest first; empty when unknown. */
  versions: string[]
  ranges: string[]
  workspaces: string[]
  count: number
  files: number
  /** Exports it uses, with members and props but without sites; ask `/usages/sites` for those. */
  exports: Omit<UsedExport, 'sites' | 'truncated'>[]
}

/** `GET /api/api-surface/usages/package?name=`: who uses a package and which parts of it. */
export interface PackageUsageView {
  name: string
  /** Versions in use across repositories, highest first. */
  versions: string[]
  repos: PackageUsageRepo[]
  exports: FleetExport<RepoRef>[]
  /** When the server last read the usage records. */
  indexedAt?: Timestamp
}

/** `GET /api/api-surface/usages/sites?package=&export=&member=&prop=&kind=&repo=&limit=`. */
export interface UsageSitesView {
  sites: FoundSite<RepoRef>[]
  /** Uses matching the query, including those records keep no snippet for. */
  total: number
  /** Kept sites beyond `limit`. */
  more: number
}

/** A package one repository uses, as `GET /api/api-surface/usages/repo` lists them. */
export interface RepoPackageView {
  name: string
  versions: string[]
  ranges: string[]
  /** The repository defines the package itself. */
  local: boolean
  count: number
  files: number
  exports: number
}

/** `GET /api/api-surface/usages/repo?repo=forge:path`: what a repository uses. */
export interface RepoUsageView {
  repo: RepoRef
  analysisId: string
  analyzedAt: Timestamp
  files: number
  types: TypeResolution
  packages: RepoPackageView[]
}

/** `GET /api/api-surface/usages/impact?package=&from=&to=&repo=`: what an upgrade affects. */
export interface UpgradeImpactView {
  /** Repository that defines the package. */
  repo: RepoRef
  from: PublicApiVersion
  to: PublicApiVersion
  impact: UpgradeImpact<RepoRef>
}

/** A personal access token for the MCP endpoint; the secret itself is shown only once. */
export interface McpTokenView {
  id: string
  name: string
  /** First characters of the secret, to tell tokens apart. */
  prefix: string
  createdAt: Timestamp
  expiresAt?: Timestamp
  /** Updated at most once an hour. */
  lastUsedAt?: Timestamp
}

/** `GET /api/api-surface/mcp/tokens`: the caller's tokens. */
export interface McpTokenList {
  tokens: McpTokenView[]
  /** False when the store has no key-value state, so tokens cannot be issued. */
  available: boolean
}

/** `POST /api/api-surface/mcp/tokens`. */
export interface CreateMcpTokenInput {
  name: string
  /** Days until it expires; `0` for never. Default 90. */
  expiresInDays?: number
}

/** Answer to `POST /api/api-surface/mcp/tokens`. */
export interface CreateMcpTokenResult {
  token: McpTokenView
  /** Send as `Authorization: Bearer <secret>`; not retrievable later. */
  secret: string
}

/** One MCP tool call, for the recent calls list. */
export interface McpCallView {
  at: Timestamp
  tool: string
  /** Principal id; names come from `people`. */
  principal: string
  /** First word of the client's User-Agent, e.g. `claude-code/2.1.0`. */
  client?: string
  /** Package or query the call was about. */
  subject?: string
  ok: boolean
  durationMs: number
}

/** Calls per day. */
export interface McpUsageDay {
  date: string
  calls: number
  errors: number
}

/** `GET /api/api-surface/mcp/usage?days=`: how agents use the MCP endpoint. */
export interface McpUsageOverview {
  days: McpUsageDay[]
  totals: { calls: number; errors: number; people: number }
  /** Sorted by calls, most first. */
  tools: { tool: string; calls: number; errors: number }[]
  packages: { name: string; calls: number }[]
  clients: { client: string; calls: number }[]
  /** Per principal; only for callers with `users:read`, else just the caller. */
  people: { id: string; name: string; calls: number }[]
  /** Newest first; other people's calls only for callers with `users:read`. */
  recent: McpCallView[]
  /** URL to configure in MCP clients. */
  endpoint: string
}

/** A library row of `GET /api/libraries`. */
export interface LibrarySummary {
  ecosystem: LibraryEcosystem
  name: string
  description?: string
  latest?: string
  repository?: string
  /** Indexed versions, highest first. */
  versions: string[]
  /** Repositories using it that the caller may read. */
  repos: number
  chunks: number
  issues: number
  /** Sources whose last fetch failed, library-wide or for any version. */
  failed: string[]
  updatedAt: Timestamp
}

/** `GET /api/libraries?q=&ecosystem=` — libraries used by repositories the caller may read, by name. */
export interface LibraryList {
  libraries: LibrarySummary[]
  /** Last indexing run, when one finished. */
  lastRun?: LibraryIndexRun
  /** Whether the server indexes libraries at all (a store with `libraries` and the setting on). */
  enabled: boolean
}

/** Outcome of one indexing run. */
export interface LibraryIndexRun {
  startedAt: Timestamp
  finishedAt?: Timestamp
  libraries: number
  versionsAdded: number
  versionsRemoved: number
  librariesRemoved: number
  failures: { library: string; version?: string; source: string; message: string }[]
  error?: string
}

/** `GET /api/libraries/:ecosystem/:name` — one library with its versions and documents. `usedBy` lists only readable repositories. */
export interface LibraryDetail {
  library: LibraryRecord
  versions: LibraryVersionRecord[]
  /** Document paths per source of the newest indexed version. */
  documents: { source: LibraryChunk['source']; path: string; chunks: number }[]
}

/** `GET /api/libraries/search?q=&ecosystem=&name=&version=&limit=` — matching chunks, best first. */
export interface LibrarySearchResult {
  hits: { chunk: LibraryChunk; score: number }[]
}

/** `POST /api/libraries/reindex` (global `analyses:run`) — starts a run unless one is going. */
export interface LibraryReindexResult {
  started: boolean
}

/** A GitHub rate limit of one token and resource, as `GET /rate_limit` reports it. */
export interface GitHubLimitView {
  limit: number
  used: number
  remaining: number
  resetAt: Timestamp
}

/** Requests sent to GitHub. `notModified` answered from the `ETag` cache cost nothing. */
export interface GitHubRequestCounts {
  requests: number
  notModified: number
  /** Answers that were a rate limit (primary or secondary). */
  limited: number
  /** Times every token was exhausted and the client waited, and for how long in all. */
  waits: number
  waitMs: number
}

/** One GitHub token credential named by the `libraries.github` setting. */
export interface GitHubTokenView {
  credentialId: string
  name: string
  /** GitHub account of the token, when it could be asked. */
  login?: string
  /** Credential id of an earlier token of the same account; requests skip this one. */
  duplicateOf?: string
  /** Live limits by resource (`core`, `search`, `graphql`, ...). */
  limits?: Record<string, GitHubLimitView>
  /** Why `login`/`limits` are missing: unreadable credential, rejected token, GitHub unreachable. */
  error?: string
  /** Requests over the asked days, by resource. */
  usage: Record<string, GitHubRequestCounts>
}

/** `GET /api/libraries/github?days=30` (global `settings:read`) — use and limits of the GitHub tokens. */
export interface GitHubTokenUsage {
  tokens: GitHubTokenView[]
  /** Requests sent without a token, by resource. */
  anonymous: Record<string, GitHubRequestCounts>
  /** One entry per UTC day of the range, oldest first; `byToken` keyed by credential id, `anonymous` for none. */
  days: { day: string; total: GitHubRequestCounts; byToken: Record<string, number> }[]
  totals: GitHubRequestCounts
  /** Live limits summed over the distinct accounts, by resource: what the pool can spend per window. */
  capacity: Record<string, GitHubLimitView>
}
