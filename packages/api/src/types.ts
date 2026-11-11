import type { Grant, GroupMatch, Principal, Scope } from '@holtkeeper/access'
import type { TranscriptLine } from '@holtkeeper/agent'
import type { ApiPackage, ApiSymbol, PackageDiff } from '@holtkeeper/api-surface'
import type { AssetsPolicy, AssetsSummary } from '@holtkeeper/assets'
import type { AuthInfo } from '@holtkeeper/auth'
import type { BundlePoint, BundleSeries } from '@holtkeeper/bundles'
import type { Conflict, FileDiff } from '@holtkeeper/changes'
import type { Card } from '@holtkeeper/chat'
import type { CiJobsData, CiProblem, CiProblemKind } from '@holtkeeper/ci-jobs'
import type {
  ChangedFilesCoverage,
  CoverageFileChange,
  CoverageGroup,
  CoverageTotals,
  FileCoverageData,
} from '@holtkeeper/coverage'
import type { RepoRef, SshKeyUsage } from '@holtkeeper/forge'
import type { FamilySuggestion, GuideBlock, GuideCaps, GuideTask } from '@holtkeeper/guide'
import type { Issue } from '@holtkeeper/issues'
import type { JobLogLine, JobLogPage, JobStep, JobWait, WaitReason } from '@holtkeeper/jobs'
import type {
  DeployState,
  FlowDetection,
  GateResult,
  ReleaseBoardRow,
  ReleaseEdits,
  ReleaseEvent,
  ReleaseLink,
  ReleasePlan,
  ReleaseSettings,
  ReleaseVersion,
  ReleaseVersionDetail,
  VersionTag,
} from '@holtkeeper/release'
import type { Metric, Report } from '@holtkeeper/report'
import type {
  AgentTask,
  AgentTaskGroup,
  AgentTaskKind,
  AgentTaskSource,
  AgentTaskStatus,
  AiUsageBucket,
  AiUsageDimension,
  AiUsageRecord,
  AiUsageTotals,
  AuditEvent,
  AuditRun,
  AuditTrigger,
  Family,
  GuideRevision,
  GuideScopeKey,
  GuideSection,
  GuideSectionName,
  LearningCandidate,
  LearningScopeKind,
  ReactionTotals,
  AuditVerification,
  CredentialCapabilities,
  ExternalVerification,
  ConfigDocumentType,
  ConfigRevision,
  GroupDocumentData,
  Job as StoredJob,
  JobAttempt,
  JobFailureGroup,
  KnowledgeEntry,
  KnowledgeKind,
  KnowledgeLink,
  KnowledgePackage,
  KnowledgeVisibility,
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
  LibraryVersionRole,
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
  /**
   * The `access.crossTeam` level: unless `off`, any read grant also reaches every team's catalog
   * (Dependencies, Public API, Stack).
   */
  crossTeam: CrossTeamLevel
}

/** Levels of the `access.crossTeam` setting. */
export type CrossTeamLevel = 'off' | 'metadata' | 'snippets'

/** `PUT /api/me/avatar` — a new avatar seed (accounts of the `users` provider only); `null` resets it. */
export interface SetAvatarInput {
  seed: string | null
}

/** `GET /api/me/preferences`: the signed-in principal's own UI preferences. */
export interface UserPreferences {
  /**
   * Groups the *My team* scope shows. A UI default, never a permission: the groups in the
   * principal's grants until it picks its own.
   */
  homeGroups: GroupMatch[]
  /** `homeGroups` comes from the grants because the principal never picked any. */
  homeGroupsFromGrants: boolean
}

/** `PUT /api/me/preferences`; `homeGroups: null` goes back to the groups in the grants. */
export interface UserPreferencesInput {
  homeGroups?: GroupMatch[] | null
}

/**
 * `GET /api/history` — audit events the caller may see, newest first; pass `nextCursor` as
 * `cursor` for the next page. Filters: `actor`, `action` (prefix), `repo`, `repos` (comma list),
 * `outcome`, `via`, `from`, `to`.
 */
export interface HistoryList {
  events: AuditEvent[]
  nextCursor?: string
  /** Users among the events' actors, by id; other actors (webhooks, the system) are absent. */
  people: Record<string, PersonView>
}

/** `GET /api/history/scope` — what the caller's History can show. */
export interface HistoryScope {
  /** Repositories with events the caller may see, with the groups the config puts them in. */
  repos: { repo: string; groups: string[] }[]
  /** Whether instance-level events (settings, users, credentials) are visible: global `audit:read`. */
  instance: boolean
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
  /** `gitlab:<forgeId>`, `github:<forgeId>`, ... */
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
  /** Set when the caller holds `settings:write` on this repository. */
  configurable?: true
  latestAudit?: AuditRunSummary
  /** The newest record of each analysis kind, when the caller may read analyses. */
  latestAnalyses?: AnalysisSummary[]
}

/** `GET /api/repos` */
export interface RepoList {
  repos: RepoSummary[]
}

export type {
  Card as ChatCard,
  CardAction as ChatCardAction,
  CardBlock as ChatCardBlock,
  CardStep as ChatCardStep,
  CardTone as ChatCardTone,
  Form as ChatForm,
  FormField as ChatFormField,
  StepStatus as ChatStepStatus,
} from '@holtkeeper/chat'

/** Someone in a team chat thread, as people see them; the model only ever gets `label`. */
export interface ChatParticipantView {
  /** Principal id. */
  id: string
  /** Stable per thread, by first appearance: `Participant A`, `Participant B`, … */
  label: string
  /** Set for accounts of the `users` provider. */
  name?: string
  avatarUrl: string
}

/** A team chat thread the caller can see. */
export interface ChatThreadView {
  id: string
  title: string
  /** `forge:path` of the repository it is about. */
  repo?: string
  /** Config group it is about. */
  group?: string
  /** Config groups of its repository, or its group; empty for team-wide threads. */
  groups: string[]
  createdBy: string
  createdAt: string
  /** Time of the last message or change. */
  updatedAt: string
  archived: boolean
  /** The agent answers every message, not only `@holtkeeper` mentions. */
  autoReply: boolean
  /** The agent is writing a reply. */
  replying: boolean
  /** Messages others wrote after the caller's read marker. */
  unread: number
  participants: ChatParticipantView[]
  /** Whether older messages are summarized for the agent. */
  summarized: boolean
}

/** One tool the agent used for a reply and how often. */
export interface ChatToolUseView {
  tool: string
  calls: number
}

/** One message of a team chat thread. */
export interface ChatMessageView {
  id: string
  threadId: string
  /** Orders messages; the cursor of `before` and `after`. */
  seq: number
  authorType: 'human' | 'agent' | 'system'
  /** Principal id of a human author. */
  authorId?: string
  /** Participant label of a human author. */
  authorLabel?: string
  /** Markdown. */
  body: string
  card?: Card
  toolTrace?: ChatToolUseView[]
  costUsd?: number
  /** Transcript of the agent run that wrote the reply; read it at `GET /api/chat/messages/:id/transcript`. */
  transcriptRef?: string
  mentions: string[]
  createdAt: string
  /** When a card was last changed in place, e.g. a deploy that moved on. */
  updatedAt?: string
}

/** A command people can run from the chat, for hints. */
export interface ChatCommandView {
  name: string
  summary: string
  usage?: string
}

/** `GET /api/chat/threads?archived=` — threads the caller can see, newest activity first, and the commands. */
export interface ChatThreadList {
  threads: ChatThreadView[]
  commands: ChatCommandView[]
  /** Config groups the caller may start a group thread in. */
  groups: string[]
}

/** Someone the composer can mention: an enabled account of the `users` provider that can see the thread. */
export interface ChatPersonView {
  id: string
  /** What follows `@` to mention them: the part of the email before `@`, else the name without spaces. */
  handle: string
  name: string
  avatarUrl: string
}

/** `GET /api/chat/threads/:id/people` — people who can be mentioned in a thread, by name. */
export interface ChatPeopleView {
  people: ChatPersonView[]
}

/** `POST /api/chat/threads` — a new thread, optionally about one repository or group. */
export interface ChatThreadInput {
  title: string
  repo?: string
  group?: string
  autoReply?: boolean
}

/** `PATCH /api/chat/threads/:id` */
export interface ChatThreadPatchInput {
  title?: string
  archived?: boolean
  autoReply?: boolean
}

/**
 * `GET /api/chat/threads/:id/messages?before=&after=&changedSince=&limit=` — a page of messages,
 * oldest first: the newest page (or the one before `before`), or the messages after `after` for
 * polling, plus those changed in place since `changedSince`.
 */
export interface ChatMessageList {
  thread: ChatThreadView
  messages: ChatMessageView[]
  /** Older messages exist before the first one returned. */
  hasMore: boolean
  /**
   * Pass as `after` on the next poll: the newest `seq` of the page (or the `after` given). Never
   * advance it from a message received any other way, or messages stored in between are skipped.
   */
  cursor: number
  /**
   * Pass as `changedSince` on the next poll; a little behind the server's clock, so changes
   * committed late still show up (repeated messages are expected).
   */
  serverTime: string
}

/**
 * `POST /api/chat/threads/:id/messages` — a message. A body starting with `/` runs a command
 * (about `repo`, else the thread's repository) whose answer is a card message; a message that
 * mentions `@holtkeeper`, or any message in a thread with `autoReply`, asks the agent to reply.
 */
export interface ChatPostInput {
  body: string
  repo?: string
}

/** What posting did; command answers are already stored, the agent's reply comes later. */
export interface ChatPostResult {
  message: ChatMessageView
  replying: boolean
}

/** `POST /api/chat/threads/:id/read` */
export interface ChatReadInput {
  messageId: string
}

/** `GET /api/chat/unread` — unread messages per visible thread with any, and their sum. */
export interface ChatUnreadView {
  threads: Record<string, number>
  total: number
}

/** `GET /api/slack`: whether Slack app tokens are stored for a future integration. */
export interface SlackSettingsView {
  configured: boolean
  connectedAt?: string
  connectedBy?: string
}

/** `PUT /api/slack/connection` */
export interface SlackConnectInput {
  botToken: string
  signingSecret: string
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
  /** What the last `POST /api/credentials/:id/test` found the provider can do. */
  capabilities?: CredentialCapabilities
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
  /** Stored probe results; set for Anthropic and Anthropic-compatible providers. */
  capabilities?: CredentialCapabilities
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
  /** Only one value for every repository: entries must be scoped `{ all: true }`. */
  global?: boolean
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
  people: Record<string, PersonView>
}

/** `PUT /api/settings` — creates or, with `id`, replaces an entry. */
export interface PutSettingInput {
  id?: string
  key: string
  scope: Scope
  value: unknown
}

/** `GET /api/settings/resolve?repo=forge:path` — the winning entry per key and what it overrides. */
export interface ResolvedSettings {
  repo: RepoRef
  groups: string[]
  settings: Record<string, SettingView>
  /**
   * Every entry covering the repository per key, the one that applies first, then the ones it
   * overrides from narrow to broad.
   */
  cascade: Record<string, SettingView[]>
}

/** One repository on the CI overview, from its newest `ci-jobs` record. */
export interface CiRepoCard {
  repo: RepoRef
  analysisId: string
  createdAt: Timestamp
  /** Branch the numbers describe; every ref when absent. */
  ref?: string
  lastRunAt?: Timestamp
  pipelines: number
  /** Median and p90 pipeline time of passing pipelines, seconds. */
  median?: number
  p90?: number
  successRate?: number
  /** Percent change of the median over the last 7 days against the 7 before. */
  change?: number
  /** Median pipeline time per week, oldest first; `null` for weeks without a passing pipeline. */
  weeks: (number | null)[]
  /** Jobs on the problem list. */
  problems: number
}

/** `GET /api/ci` — repositories the caller may read with CI runs in the last 30 days. */
export interface CiOverview {
  repos: CiRepoCard[]
}

/**
 * `GET /api/ci/repo?repo=` — the newest `ci-jobs` record of one repository; `data` is absent
 * until the analyzer has run in the current format.
 */
export interface CiRepoView {
  repo: RepoRef
  analysisId?: string
  createdAt?: Timestamp
  data?: CiJobsData
  /** At most five problem jobs, kinds taken in turn. */
  problems: CiProblem[]
  /** Problems of every job that has one, by job name. */
  flags: Record<string, CiProblemKind[]>
}

/** Line and branch coverage of one coverage record, percent. */
export interface CoverageTrendPoint {
  at: Timestamp
  lines?: number
  branches?: number
}

/** One repository's newest `coverage` record as a card. */
export interface CoverageRepoCard {
  repo: RepoRef
  /** Config groups of the repository, for the scope switch. */
  groups: string[]
  analysisId: string
  createdAt: Timestamp
  ref?: string
  /** Commit the record ran on. */
  sha?: string
  /** Default-branch head freshness last saw, set only when it differs from `sha`. */
  head?: string
  tools: string[]
  totals: CoverageTotals
  /** Points of line coverage gained since the previous record; absent without one. */
  change?: number
  /** Coverage of the files that changed since the previous record; absent without one. */
  changed?: ChangedFilesCoverage
  /** Recent records, oldest first, the newest included. */
  trend: CoverageTrendPoint[]
}

/** `GET /api/coverage` — repositories the caller may read that have a coverage record. */
export interface CoverageOverview {
  repos: CoverageRepoCard[]
}

/**
 * `GET /api/coverage/repo?repo=` — one repository's coverage card with its breakdown per package
 * or top-level folder, the files with the most uncovered lines and the files that moved since the
 * previous record. `card` is absent until the coverage analyzer has run.
 */
export interface RepoCoverageView {
  repo: RepoRef
  card?: CoverageRepoCard
  groups: CoverageGroup[]
  worst: FileCoverageData[]
  changes: CoverageFileChange[]
}

/** Total bytes and policy violations of one assets record. */
export interface AssetsTrendPoint {
  at: Timestamp
  totalBytes: number
  violations: number
}

/**
 * Where an effective `assets.policy` comes from: the default, or the most specific entry by its
 * scope level. `entry` names that entry and is set only for callers with `settings:read` on its
 * scope.
 */
export interface AssetsPolicySource {
  level: 'default' | 'all' | 'group' | 'repo'
  entry?: { id: string; scope: Scope }
}

/**
 * `GET /api/assets/repo?repo=` — a repository's asset policy and its newest assets record. The
 * record fields are absent until the `assets` analyzer has run.
 */
export interface RepoAssetsView {
  repo: RepoRef
  /** The effective `assets.policy`, defaults filled in. */
  policy: AssetsPolicy
  /** Where the effective policy comes from. */
  policySource: AssetsPolicySource
  /** Recent records, oldest first. */
  trend: AssetsTrendPoint[]
  analysisId?: string
  createdAt?: Timestamp
  ref?: string
  sha?: string
  /** Whether the newest record was checked against a policy; older records were not. */
  checkedPolicy?: boolean
  summary?: AssetsSummary
}

/** Compact view of an analysis record for lists. */
export interface AnalysisSummary {
  id: string
  repo: RepoRef
  kind: string
  label: string
  ref?: string
  /** Commit the analysis ran on, when known. */
  sha?: string
  createdAt: Timestamp
  actor?: string
  metrics: Metric[]
}

/** `GET /api/analyses?repo=&kind=&before=&limit=` */
export interface AnalysisList {
  analyses: AnalysisSummary[]
  /** Names and avatars of the users among the records' actors. */
  people: Record<string, PersonView>
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

/** What a stack component is: a language runtime, package manager, service image, base system, other image or tool. */
export type StackComponentKind = 'runtime' | 'package-manager' | 'service' | 'os' | 'image' | 'tool'

/** Support of a release line when the stack analysis ran: ended, ending within its `soonDays`, LTS, active, not known. */
export type StackSupport = 'eol' | 'eol-soon' | 'lts' | 'active' | 'unknown'

/** How far a used version is behind the component's latest release; `floating` names no version. */
export type StackLag = 'current' | 'patch' | 'minor' | 'major' | 'ahead' | 'unknown' | 'floating'

/** One place one repository names a version of a stack component, judged when the analysis ran. */
export interface StackUse {
  /** Repository path on the group's forge. */
  repo: string
  file: string
  via: 'version-file' | 'dockerfile' | 'compose' | 'ci' | 'deploy'
  /** As written, e.g. `22-alpine`. */
  declared: string
  /** Comparable version as precise as written; absent when floating. */
  version?: string
  variant?: string
  image?: string
  lag: StackLag
  support: StackSupport
  /** Release line the version belongs to, e.g. `22`. */
  cycle?: string
  /** End of life of that line, `YYYY-MM-DD`. */
  eolDate?: string
}

/** A runtime, package manager, image or tool one group uses, with every use. */
export interface StackTool {
  /** Stable across records and groups: `node`, `postgres`, `image:registry.test/shapes/base`. */
  id: string
  name: string
  kind: StackComponentKind
  latest?: string
  /** Newest release of a supported LTS line, for products that have them. */
  latestLts?: string
  uses: StackUse[]
}

export type StackConventionMode = 'exact' | 'json-subset' | 'yaml-subset' | 'lines-present'

/** A repository file against a convention's golden content: `error` when it could not be compared. */
export type StackConventionStatus = 'matches' | 'drifts' | 'missing' | 'error'

/** One repository checked against one convention of its group. */
export interface StackConventionResult {
  repo: string
  /** The convention's file path. */
  file: string
  mode: StackConventionMode
  status: StackConventionStatus
  problems: string[]
  /** Id of the suggested fix, for `POST /api/analyses/:analysisId/changes`. */
  changeId?: string
  /** What the suggested fix changes, per file. */
  diff?: FileDiff[]
}

/** A repository of a group's stack record. */
export interface StackRepoView {
  path: string
  /** Config groups of the repository, for folding other teams. */
  groups: string[]
  webUrl?: string
  /** Set when the analysis could not read it. */
  error?: string
  archived?: boolean
}

/** The newest `stack` record of one config group, limited to the repositories the caller may read. */
export interface StackGroupView {
  forge: string
  group: string
  analysisId: string
  createdAt: Timestamp
  /** When versions and release lines were looked up; support is judged at this time. */
  checkedAt: Timestamp
  soonDays: number
  repos: StackRepoView[]
  tools: StackTool[]
  conventions: StackConventionResult[]
  /** Since the group's previous record: uses that newly reached or left an ended or ending line. */
  changes?: {
    since: Timestamp
    newEol: number
    resolvedEol: number
    newDrifts: number
    resolvedDrifts: number
  }
}

/**
 * `GET /api/stack` — the newest `stack` record of every config group with a repository the caller
 * may read (`analyses:read`), one entry per group. Reads stored records only.
 */
export interface StackOverview {
  groups: StackGroupView[]
}

/** A repository in the dependency table and the `depgraph` record its dependencies come from. */
export interface DependencyRepo {
  repo: RepoRef
  /** Config groups of the repository, for folding other teams. */
  groups: string[]
  analysisId?: string
  ref?: string
  createdAt?: Timestamp
  /** Libraries it uses at an exact version. */
  dependencies: number
}

/** Repositories on one version of a library, and how far that version is behind the latest. */
export interface DependencyVersionSpread {
  version: string
  repos: number
  /** Breaking releases behind the registry's latest: majors, and minors below 1.0. */
  majorsBehind: number
}

/** Renovate's update merge requests for a library: `broken` (failed pipeline or error), `open`, `none`. */
export type DependencyRenovateState = 'broken' | 'open' | 'none'

/** One library row of `GET /api/dependencies`. */
export interface DependencyRow {
  ecosystem: LibraryEcosystem
  name: string
  /** Defined by one of the organization's repositories; never part of the third-party counts. */
  internal: boolean
  /** Repositories using it as `forge:path` (see `DependencyTable.repos` for groups) and their versions. */
  usedBy: { repo: string; versions: string[] }[]
  /** Lowest version first. */
  versions: DependencyVersionSpread[]
  /** Newest release the registry reported, from the library index runs. */
  latest?: string
  /** The most breaking releases any repository is behind `latest`. */
  majorsBehind: number
  /** Repositories on a version at least one breaking release behind `latest`. */
  reposBehind: number
  /** Distinct advisories in the newest audits of the repositories using it, with the worst severity. */
  advisories: { count: number; severity?: Severity }
  /** Distinct license expressions the newest license scans report. */
  licenses: string[]
  /** The worst license verdict of those scans, by the repositories' own policies. */
  licenseVerdict?: string
  renovate: DependencyRenovateState
}

/**
 * `GET /api/dependencies` — one row per library (npm and Go) the readable repositories use,
 * from their newest `depgraph` and `usages` records, joined with the latest versions of the
 * library index, the newest audits, license scans and Renovate records. Reads stored data only.
 */
export interface DependencyTable {
  repos: DependencyRepo[]
  /** Third-party first, then by breaking releases behind, advisories, repositories and name. */
  libraries: DependencyRow[]
  totals: {
    /** Third-party libraries. */
    libraries: number
    internal: number
    behindMajor: number
    withAdvisories: number
    renovateOpen: number
    renovateBroken: number
  }
}

/** An advisory one of the library's used versions is affected by. */
export interface DependencyAdvisory {
  id: string
  severity: Severity
  summary: string
  url: string
  fixedVersions: string[]
  /** Affected versions seen in the audits. */
  versions: string[]
  /** Repositories whose newest audit reports it, as `forge:path`. */
  repos: string[]
}

/** The license of one version and each repository policy's verdict on it. */
export interface DependencyLicense {
  version: string
  licenses: string[]
  verdicts: { verdict: string; repos: string[] }[]
}

/** The library's share of one measured bundle. */
export interface DependencyBundleShare {
  repo: string
  /** `build <name>` or `package <name>@<version>`. */
  target: string
  gzip: number
  /** The target's total gzip size. */
  total?: number
  versions: string[]
  entrypoints: number
}

/** An accepted knowledge entry about the library; people's entries come before agents'. */
export interface DependencyDecision {
  id: string
  title: string
  kind: KnowledgeKind
  source: 'human' | 'agent'
  author: string
  updatedAt: Timestamp
  /** The teams (config groups) the entry belongs to; empty for entries about everything. */
  owner: string[]
  /** Read through the cross-team catalog: another team's `shared` entry. */
  shared: boolean
}

/** A Renovate merge request carrying an update of the library. */
export interface DependencyMergeRequest {
  repo: string
  id: number
  url?: string
  title: string
  status: 'broken' | 'open' | 'draft'
  /** Version the update moves to. */
  next?: string
}

/**
 * `GET /api/dependencies/library?ecosystem=&name=` — the Overview and Docs tabs of one library:
 * who uses which version, advisories, licenses, bundle shares, team decisions, open update merge
 * requests, the indexed versions and the documents of the newest indexed one.
 */
export interface DependencyDetail {
  ecosystem: LibraryEcosystem
  name: string
  internal: boolean
  latest?: string
  latestCheckedAt?: Timestamp
  description?: string
  homepage?: string
  repository?: string
  usedBy: { repo: RepoRef; groups: string[]; versions: string[]; majorsBehind: number }[]
  versions: DependencyVersionSpread[]
  /** Versions the library index keeps, highest first. */
  indexed: {
    version: string
    roles: LibraryVersionRole[]
    publishedAt?: Timestamp
    deprecated?: string
  }[]
  advisories: DependencyAdvisory[]
  licenses: DependencyLicense[]
  bundles: DependencyBundleShare[]
  decisions: DependencyDecision[]
  mergeRequests: DependencyMergeRequest[]
  docs: {
    version?: string
    documents: { source: LibraryChunk['source']; path: string; chunks: number }[]
  }
}

/** One API change between the two versions of an upgrade; `added` exports are left out. */
export interface DependencyApiChange {
  change: 'removed' | 'changed' | 'deprecated'
  subpath: string
  name: string
  kind?: string
  before?: string
  after?: string
}

/**
 * `GET /api/dependencies/upgrade?ecosystem=&name=&from=&to=` — the Upgrade tab: changelog and
 * migration notes in (from, to], the API changes and the uses they affect in readable
 * repositories (npm). `from` defaults to the oldest version in use, `to` to the latest.
 */
export interface DependencyUpgrade {
  ecosystem: LibraryEcosystem
  name: string
  from?: string
  to?: string
  /** Markdown from the library index; third-party text, never instructions. */
  changes?: string
  api?: DependencyApiChange[]
  impact?: UpgradeImpact
  /** Why a part is missing, e.g. a version without an indexed API. */
  notes: string[]
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

/** A user named by an id somewhere in a response (an actor, an author, `updatedBy`). */
export interface PersonView {
  name: string
  avatarUrl: string
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

/** `GET /api/jobs/:id` — a background analysis run with its attempts; the log is read apart. */
export type Job = StoredJob

/** A job as lists show it. */
export type JobSummary = StoredJob

/**
 * `GET /api/jobs?status=&repo=&repos=&analyzer=&trigger=&schedule=&signature=&limit=&before=` —
 * newest first, only repositories the caller may read (filtered before `limit`). `repos` is a
 * comma list of `forge:path` (group jobs: `forge:<group>`); `signature` matches `errorSignature`
 * exactly. `people` resolves the jobs' actors that are users.
 */
export interface JobList {
  jobs: JobSummary[]
  people: Record<string, PersonView>
}

export type { JobAttempt, JobFailureGroup, JobLogLine, JobStep, JobWait, WaitReason }

/** A repository or group that has jobs the caller may read, with its config groups. */
export interface JobTargetView {
  /** `forge:path`; for group jobs `forge:<group>`. */
  repo: string
  group?: string
  groups: string[]
}

/** `GET /api/jobs/targets` — every repository or group with jobs the caller may read. */
export interface JobTargetList {
  targets: JobTargetView[]
}

/**
 * `GET /api/jobs/:id/why` — why the job exists and how it stands: `origin` names the trigger,
 * schedule and retries in a sentence; `outcome` how a finished, blocked or running job stands;
 * `wait` what keeps a queued job from starting, computed from the claim rules.
 */
export interface JobWhy {
  origin: string
  /** Principal id of the person who asked for the run, resolved in `people` when a user. */
  actor?: string
  outcome?: string
  wait?: JobWait
  people: Record<string, PersonView>
}

/**
 * `GET /api/jobs/:id/log?attempt=&offset=&limit=&tail=` — one page of an attempt's log (default:
 * the latest attempt, from line 0, 500 lines, at most 2000). With `tail` the last lines instead.
 * Poll with `offset = offset + lines.length` until `complete`.
 */
export interface JobLog extends JobLogPage {
  attempt: number
  /** Attempts the job has started; attempt numbers run from 1 to this. */
  attempts: number
}

/**
 * `GET /api/jobs/:id/runs`: the job's agent runs, newest first, with what they cost together;
 * runs with a `transcriptRef` can be read through `/api/jobs/:id/transcripts/:ref`.
 */
export interface JobRunList {
  runs: AiUsageRecord[]
  costUsd: number
}

/**
 * `GET /api/jobs/:id/transcripts/:ref`, `GET /api/chat/messages/:id/transcript`: one agent run's
 * transcript (`ref` is its artifact id). Lines are its start, model messages, tool calls, tool
 * results cut to a few thousand characters, and the outcome with usage and cost; secrets are
 * redacted before anything is stored.
 */
export interface AgentTranscriptView {
  ref: string
  lines: TranscriptLine[]
}

/**
 * `GET /api/jobs/failures?days=&analyzer=&repos=` — jobs that failed for good in the last `days`
 * (default 7, at most 90), grouped by analyzer and `errorSignature`, only repositories the
 * caller may read.
 */
export interface JobFailureList {
  failures: JobFailureGroup[]
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
 * `POST /api/analyses/backfill`: runs a repository analyzer (e.g. `api-surface`, `bundle`) on past
 * releases. Answers 202 at once; repositories are walked in the background and the outcome is
 * audited as `analysis.backfill_result`. Without `repo` or `group` it covers every
 * repository of every group. `limit` newest releases per repository (default 20, at most 100); a
 * release is a plain tag or a commit carrying monorepo package tags (`@scope/name@1.2.3`).
 * Releases the analyzer has analyzed are skipped.
 */
export interface AnalysisBackfillInput {
  analyzer: string
  repo?: string
  group?: string
  limit?: number
}

export type { BundlePoint, BundleSeries }

/** One repository on the Releases overview: its snapshot row plus whether a person should act. */
export type ReleaseCard = ReleaseBoardRow & {
  /** A step is pending (candidate, proposed, awaiting a version), a deploy failed or is ready, or reading failed. */
  needsAction: boolean
}

/**
 * `GET /api/releases/overview?group=&filter=action|all&refresh=1`: one card per repository the
 * caller may read that turned releases on (`releases.enabled`). `filter=action` keeps cards that
 * need action; the default is all.
 */
export interface ReleaseOverview {
  cards: ReleaseCard[]
  /**
   * When the last full read of the forges finished. Cards come from a snapshot the server rereads
   * shortly after forge events of a repository and every half hour; `refresh` starts a full read.
   */
  readAt: string
  /** A full read is running; the cards change when it finishes. */
  refreshing: boolean
  dryRun: boolean
  /** Users among the cards' acceptances, by id. */
  people: Record<string, PersonView>
}

/** Newest recorded deploy outcome of one environment for a version. */
export interface ReleaseVersionDeploy {
  environment: string
  status: 'started' | 'succeeded' | 'failed'
  at: string
  /** Principal id or forge username of who started it. */
  actor: string
  url?: string
}

/** A past version on the timeline with its recorded deploys. */
export type ReleaseVersionView = ReleaseVersion & { deploys: ReleaseVersionDeploy[] }

/**
 * `GET /api/releases/timeline?repo=&offset=&limit=`: versions of one repository, newest first,
 * `limit` per page (default 10, at most 30). The first page (`offset` 0) of a repository with
 * releases on also carries `next`, the unreleased version from the overview snapshot. Ranges
 * between two version tags are read from the forge once and cached for good.
 */
export interface ReleaseTimelineView {
  repo: RepoRef
  /** Releases are turned on for the repository. */
  enabled: boolean
  next?: ReleaseBoardRow
  versions: ReleaseVersionView[]
  /** Versions in all; release candidates count only when the flow makes them. */
  total: number
  /** Offset of the next page while older versions remain. */
  nextOffset?: number
}

/**
 * `GET /api/releases/version?repo=&tag=`: one version in full (entries, changelog, tasks, compare
 * link) with its recorded deploys and, when environments are configured, the live deploy state.
 * 404 when the tag is not a version.
 */
export type ReleaseVersionDetailView = ReleaseVersionDetail & {
  deploys: ReleaseVersionDeploy[]
  deploy?: DeployState
}

/** `GET /api/releases/repo?repo=`: everything the release page of one repository shows. */
export interface ReleaseRepoView {
  repo: RepoRef
  row: ReleaseBoardRow
  settings: ReleaseSettings
  /** Plan of the release candidate merge request, when the source branch has changes. */
  proposal?: ReleasePlan
  /** Plan of the next version, when the target branch has unreleased changes. */
  version?: ReleasePlan
  /** Newest versions, for deploying or rolling back. */
  versions: VersionTag[]
  /** Deploy state of the latest version. */
  deploy?: DeployState
  /** Suggested flow when no setting names this repository or its groups. */
  detection?: FlowDetection
  history: ReleaseEvent[]
  /** Forge pages of the release: merge requests, tags, diffs, pipelines, project lists. */
  links: ReleaseLink[]
  /** Users among the history's actors and the acceptance, by id. */
  people: Record<string, PersonView>
  /** What the caller may do here. */
  can: { run: boolean; configure: boolean }
  readOnly: boolean
  dryRun: boolean
  /** An AI agent is configured for this repository, so notes can be written by it. */
  agent: boolean
  /**
   * Tracker issues of the tickets in `proposal` and `version`, by key, when a tracker (a `jira`
   * credential covering the repository) is connected and answered; plain keys otherwise.
   */
  issues?: Record<string, Issue>
}

/** `PUT /api/releases/edits`: a person's changes to the plan of one step; `null` drops them all. */
export interface ReleaseEditsInput {
  repo: string
  step: 'propose' | 'version'
  edits: ReleaseEdits | null
}

/**
 * `POST /api/releases/summary`: has the AI agent write the notes of one step's plan (one call on
 * the `fast` tier, style from the Guide's `releases` section); kept as an edit.
 */
export interface ReleaseSummaryInput {
  repo: string
  step: 'propose' | 'version'
}

/**
 * `POST /api/releases/propose` and `/version`: runs the step; `force` overrides failing soft
 * gates. `writeNotes` (propose only) has the AI agent write the notes first unless a person did.
 */
export interface ReleaseStepInput {
  repo: string
  force?: boolean
  writeNotes?: boolean
}

/** `POST /api/releases/accept`: accepts the target branch head for release; `DELETE` withdraws it. */
export interface ReleaseAcceptInput {
  repo: string
  note?: string
}

/** `POST /api/releases/deploy`: starts the deploy job of one environment for a version. */
export interface ReleaseDeployInput {
  repo: string
  tag: string
  environment: string
  redeploy?: boolean
  force?: boolean
}

/** What a step did. */
export interface ReleaseStepResult {
  kind: 'proposed' | 'versioned' | 'accepted' | 'deploy-started'
  url?: string
  version?: string
  tag?: string
  dryRun?: boolean
  detail: string
}

/** Answer of a refused step: the failing gates, so the UI can offer an override. */
export interface ReleaseGateError {
  error: string
  gates?: GateResult[]
}

/**
 * `GET /api/bundles/targets?repo=`: every target the newest `bundle` records of one repository
 * measured (app builds, published package versions), each with its history, oldest point first.
 */
export interface BundleTargetsView {
  series: BundleSeries[]
  /** Records read; history older than them is not shown. */
  records: number
}

/**
 * `GET /api/bundles/report?repo=&target=&version=&analysis=`: the full report of one point of a
 * target's history (a package `version` or a build's `analysis` id; the newest without either),
 * compared with the closest earlier point that measured fine.
 */
export interface BundleTargetReportView {
  report: Report
  analysisId: string
  previousAnalysisId?: string
}

/** Answer to an analysis backfill, which goes on in the background. */
export interface AnalysisBackfillStarted {
  startedAt: string
}

/** What an analysis backfill queued; the details of its `analysis.backfill_result` audit event. */
export interface AnalysisBackfillResult {
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
  needs: {
    checkout?: boolean
    forge?: boolean | 'optional'
    agent?: 'required' | 'optional'
    history?: boolean | 'optional'
  }
  /** The run changes repositories (branches, commits, merge requests). */
  exclusive?: boolean
  /**
   * How freshness keeps its records current: after the default branch moved (at most once per
   * `minInterval`), or every `cadence`; `heavy` ones wait for the night window. Absent: never
   * on its own.
   */
  refresh?:
    | { on: 'change'; minInterval: string; paths?: readonly string[]; heavy?: boolean }
    | { on: 'time'; cadence: string; heavy?: boolean }
  schema: unknown
  presets?: SettingPresetView[]
}

/** One analyzer's targets in a team, counted by what the last freshness sweep decided. */
export interface FreshnessCountsView {
  analyzer: string
  /** Due; the sweeper queues them as its hourly caps allow. */
  stale: number
  /** Stale or due but held back: debounce, night window, AI budget, a job already queued. */
  waiting: number
  fresh: number
  /** Freshness does not run it there: the team turned it off, or it is not set up or not used. */
  skipped: number
}

/**
 * \`GET /api/automation/freshness\`: the last freshness sweep summed per team, over the repositories
 * whose analyses the caller may read. Each repository counts in the every-repository row (no
 * \`group\`) and in the row of each of its config groups. \`at\` is absent before the first sweep.
 */
export interface FreshnessOverview {
  at?: Timestamp
  nextAt?: Timestamp
  sweepMinutes: number
  teams: { group?: string; analyzers: FreshnessCountsView[] }[]
}

/** `GET /api/jobs/analyzers`. */
export interface JobAnalyzerList {
  analyzers: JobAnalyzerView[]
}

/** The stack of one repository from its groups' newest `stack` records. */
export interface RepoStackView {
  checkedAt: Timestamp
  /** One row per runtime, tool or image the repository uses, worst support first. */
  tools: {
    id: string
    name: string
    declared: string
    file: string
    support: StackSupport
    eolDate?: string
  }[]
  /** Its convention checks by status. */
  conventions: Record<StackConventionStatus, number>
}

/**
 * `GET /api/repos/overview?repo=` — what the repository page's Overview cards show, from stored
 * records only: the newest record of every analysis kind (reviews left out), the default-branch
 * head freshness last saw, the newest audit (with `audits:read`), the direct dependency count and
 * the stack. Needs `analyses:read`.
 */
export interface RepoOverview {
  repo: RepoRef
  groups: string[]
  /** The default-branch head freshness last saw; records on another sha are behind it. */
  head?: { sha: string; at: Timestamp }
  analyses: AnalysisSummary[]
  audit?: AuditRunSummary
  /** Direct dependencies in the newest `depgraph` record. */
  dependencies?: { direct: number; analysisId: string; createdAt: Timestamp }
  stack?: RepoStackView
}

/** One Holtkeeper review run on a merge request, for the repository page's Reviews tab. */
export interface RepoReviewView {
  analysisId: string
  createdAt: Timestamp
  mergeRequest: { iid: number; title: string; webUrl: string; author: string }
  mode: 'full' | 'incremental' | 'reply' | 'skipped'
  verdict: 'looks-good' | 'needs-changes' | 'skipped'
  /** Comments the forge accepted. */
  posted: number
  /** Threads the run resolved. */
  resolved: number
  costUsd?: number
  /** 👍/👎 last read from the forge on this run's comments. */
  reactions: { up: number; down: number }
}

/** `GET /api/repos/reviews?repo=` — the newest 20 review runs of a repository; `analyses:read`. */
export interface RepoReviewList {
  reviews: RepoReviewView[]
  /** Sums over `reviews`. */
  totals: { costUsd: number; posted: number; up: number; down: number }
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

/** A knowledge entry; `score` is set on search results (higher is more relevant). */
export interface KnowledgeEntryView extends KnowledgeEntry {
  score?: number
  /**
   * The teams (config groups) the entry belongs to: the groups its scope names and the groups of
   * the repositories it names. Empty for entries about everything. The UI folds other teams' notes.
   */
  owner: string[]
}

/**
 * `GET /api/knowledge?status=&kind=&topic=&package=&subject=&scope=&q=&repo=&limit=` — `status` and
 * `kind` take comma lists. With `q`, best matches first; otherwise most recently updated first.
 * With `repo` (`forge:path`), every entry whose scope covers the repository; otherwise entries
 * whose scope the caller may read, plus accepted `shared` entries of other teams within the
 * caller's cross-team catalog reach.
 */
export interface KnowledgeList {
  entries: KnowledgeEntryView[]
  /** Names and avatars of the users among authors and editors. */
  people: Record<string, PersonView>
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
  /**
   * `shared` lets other teams read the entry under the cross-team catalog policy. On create, a
   * decision or convention about one package defaults to `shared` with that package as `subject`.
   */
  visibility?: KnowledgeVisibility
  /** What the entry is about: `npm:react`, `Go:example.com/kit`, `tool:node`. */
  subject?: string
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

/** One scope's Guide: every section (empty ones included) and whether the caller may edit them. */
export interface GuideScopeView {
  scope: GuideScopeKey
  /** `All repositories`, `Team games`, `Family Widgets`, `work:games/app`. */
  label: string
  sections: GuideSection[]
  canEdit: boolean
  /** Names and avatars of the users who edited rules, accepted generated text or learnings. */
  people: Record<string, PersonView>
}

/** `GET /api/guide/section?scope=&section=` — the section with its previous human layers. */
export interface GuideSectionDetail {
  section: GuideSection
  history: GuideRevision[]
  canEdit: boolean
  /** Names and avatars of the users who made the section and its revisions. */
  people: Record<string, PersonView>
}

/**
 * `PUT /api/guide/section?scope=&section=` — replaces the human layer. With `version`, it fails
 * with 409 when the section changed since. `steering` keeps its value when left out.
 */
export interface PutGuideSectionInput {
  rules: string
  steering?: string
  version?: number
}

/**
 * `POST /api/guide/section/accept?scope=repo:…&section=` — accepts the generated text waiting for a
 * person (the proposal, or a first generated layer nobody accepted); it becomes what agents see.
 * With `inputHash`, it fails with 409 unless that is still the waiting text. Answers the section.
 */
export interface AcceptGuideSectionInput {
  inputHash?: string
}

/**
 * `POST /api/guide/regenerate?repo=` — queues a `guide` job that regenerates even when the evidence
 * did not change, optionally for some sections and with a one-off extra prompt stored with the
 * result. Needs `knowledge:write` and `analyses:run` on the repository. Answers the job (201).
 */
export interface RegenerateGuideInput {
  sections?: ('general' | 'testing' | 'testids' | 'commits')[]
  prompt?: string
}

/**
 * `GET /api/guide/preview?repo=&task=&section=` — the effective Guide a task of the repository
 * gets from the panel (rules files in the repository are read by the task itself and not shown).
 */
export interface GuidePreview {
  repo: string
  task: GuideTask
  section?: GuideSectionName
  text: string
  sections: GuideSectionName[]
  blocks: GuideBlock[]
  warnings: string[]
  budget: GuideCaps & { used: number; humanUsed: number; generatedUsed: number; notesUsed: number }
}

/**
 * `GET /api/learnings?repo=&status=` — learning candidates from replies to review comments, most
 * recently updated first, of repositories the caller has `knowledge:read` on. `status` is a
 * comma-separated list. Each one says whether the caller may decide it (`knowledge:write` on its
 * repository) and which scopes it may be accepted into, most specific first.
 */
export interface LearningList {
  candidates: LearningCandidateView[]
  /** Names and avatars of the users who proposed, decided or edited candidates. */
  people: Record<string, PersonView>
}

export interface LearningCandidateView extends LearningCandidate {
  canDecide: boolean
  /** Scope keys of the repository the caller may edit: repository, family, groups, `all`. */
  scopes: GuideScopeKey[]
}

/**
 * `POST /api/learnings/:id/accept` — accepts a candidate into a scope's learnings (default: the
 * scope its `suggestedScope` points at), optionally edited first; accepting again moves it. Needs
 * `knowledge:write` on the repository and edit rights on the scope. Answers the candidate.
 */
export interface AcceptLearningInput {
  scope?: GuideScopeKey
  rule?: string
  section?: GuideSectionName
}

/** `PATCH /api/learnings/:id` — edits a candidate; an accepted one's Guide entry follows. */
export interface EditLearningInput {
  rule?: string
  section?: GuideSectionName
  suggestedScope?: LearningScopeKind
}

/**
 * `GET /api/learnings/reactions?repo=` — 👍/👎 on Holtkeeper's review comments per finding
 * category, over the repositories the caller has `knowledge:read` on.
 */
export interface ReactionTotalsList {
  totals: ReactionTotals[]
}

/** `GET /api/families` — the families the caller can see a member of. */
export interface FamilyList {
  families: Family[]
}

/**
 * `GET /api/families/suggestions` — proposed families of repositories with similar stacks and
 * dependencies that are in no family yet; only those the caller could create, minus dismissed ones.
 */
export interface FamilySuggestionList {
  suggestions: FamilySuggestion[]
}

/**
 * `POST /api/families/suggestions/dismiss` — hides the suggestion with exactly these members (any
 * order) for everyone; a suggestion whose member set changes shows up again.
 */
export interface FamilySuggestionDismissInput {
  members: string[]
}

/** `POST /api/families`, `PUT /api/families/:id` — members as `forge:path`, at least two. */
export interface FamilyInput {
  name: string
  members: string[]
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
  /** Never scanned since statistics were reset, not backing a constraint and not a full-text search (GIN, GiST) index. */
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

/**
 * An `llm.budget` setting, or the implicit default budget, and how much of it this week used.
 * Weeks run from Monday 00:00 to Monday 00:00 in the instance time zone.
 */
export interface AiBudgetStatus {
  /** Setting entry id, or `default` for the budget that applies when no global one is set. */
  id: string
  scope: Scope
  action: 'warn' | 'block'
  weeklyUsd: number
  /** Part of `weeklyUsd` only work a person started may spend. */
  reserveUsd: number
  spentUsd: number
  /** `spentUsd / weeklyUsd * 100`. */
  percent: number
  /** Linear projection of this week's spend to its end. */
  projectedUsd: number
  week: { from: Timestamp; to: Timestamp; key: string }
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
  /** Budgets whose scope the caller may read; the default one only for readers of everything. */
  budgets: AiBudgetStatus[]
  /** This month's cache read tokens over all input tokens (fresh, cache read and cache write); 0 without input. */
  cacheHitRatio: number
  /** This month's failed runs over runs that were not denied; 0 without runs. */
  errorRate: number
}

/** A forge as the panel shows it; the webhook secret is never included. */
export interface ForgeConfigView {
  kind: string
  url: string
  credentialId: string
  /** Jobs read its package registries with its token, through the egress proxy. */
  packages?: boolean
  /** The egress proxy caches the package files jobs download from it. */
  cachePackages?: boolean
  /** Username Holtkeeper posts as on this forge; its own events and merge requests are ignored. */
  botUsername?: string
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

/** One panel config entry: `data` is the effective value, `version` that of its document. */
export interface ConfigEntryView<T extends ConfigDocumentType = ConfigDocumentType> {
  type: T
  id: string
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
    botUsername?: string
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

/**
 * `GET /api/forges/:id/repositories?search=&limit=`: repositories the forge's token is a member
 * of, most recently active first, for picking one to add. Archived ones are left out.
 */
export interface ForgeRepositoryList {
  entries: { path: string; name: string; webUrl: string }[]
}

/**
 * `GET /api/forges/:id/repositories/access?path=team/app`: whether the forge's token can read a
 * repository before it is added. `ok`: readable and not archived. `not-found`: the path does not
 * exist or the token's account is not a member (GitLab answers 404 for both). `unauthorized`: the
 * token is invalid or expired. `forbidden`: the token lacks a scope. `archived`: Holtkeeper skips
 * archived repositories. `error`: the forge could not be asked. `account` is the token's account
 * when the forge tells it, the one to invite.
 */
export interface RepoAccessView {
  status: 'ok' | 'not-found' | 'unauthorized' | 'forbidden' | 'archived' | 'error'
  message?: string
  account?: { username: string; name: string }
  repository?: { path: string; name: string; webUrl: string }
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
  /** Jobs an AI budget refused or stopped. */
  blocked: number
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
 * the background and ends in a `schedule.run_result` audit event with `ScheduleRunResult` details.
 */
export interface ScheduleRunStarted {
  id: string
  startedAt: string
}

/** Details of a `schedule.run_result` audit event: what a manual run queued, or why it failed. */
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

/**
 * A package its repository dropped: at least two non-empty default branch runs since its last
 * record lack it, so new code should not depend on it.
 */
export interface PublicApiPackageRemoval {
  /** The first non-empty default branch run without the package. */
  at: Timestamp
  /** Other readable repositories that still have a package of this name. */
  movedTo?: RepoRef[]
  /** A package that took its folder in the newest default branch run, likely its new name. */
  renamedTo?: string
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
  /** Set when the repository no longer has the package; the other fields describe its last record. */
  removed?: PublicApiPackageRemoval
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
  /** Set when the repository no longer has the package. */
  removed?: PublicApiPackageRemoval
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
  /** The config groups the repository is in: its owning teams, for folding other teams. */
  groups: string[]
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

/** A package one repository defines, with how much the readable repositories use it. */
export interface PublishedPackageView {
  name: string
  version?: string
  description?: string
  private: boolean
  /** Folder of the package in the repository. */
  dir: string
  exports: number
  /** Repositories whose newest `usages` record imports the package. */
  repos: number
  /** Uses summed over those repositories. */
  count: number
  files: number
}

/**
 * `GET /api/api-surface/usages/published?repo=`: the packages the newest API records of one
 * repository describe, most used first.
 */
export interface PublishedPackagesView {
  packages: PublishedPackageView[]
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
  /** Extra powers beyond reading; absent for read-only tokens. */
  scopes?: McpTokenScope[]
}

/**
 * Extra powers of an MCP token. `release` lets it run release steps (`release_step`) where its
 * owner may (`releases:run`); `tasks` lets `start_task` queue tasks right away and
 * `request_review` ask for reviews where its owner may (`tasks:run`); without them a token only
 * reads and proposes tasks.
 */
export type McpTokenScope = 'release' | 'tasks'

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
  /** Default none: the token only reads. */
  scopes?: McpTokenScope[]
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

/** A library row of `GET /api/system/library-index`. */
export interface LibrarySummary {
  ecosystem: LibraryEcosystem
  name: string
  description?: string
  latest?: string
  repository?: string
  /** Indexed versions, highest first. */
  versions: string[]
  /** Repositories using it. */
  repos: number
  chunks: number
  issues: number
  /** Sources whose last fetch failed, library-wide or for any version. */
  failed: string[]
  updatedAt: Timestamp
}

/**
 * `GET /api/system/library-index?q=&ecosystem=` (global `settings:read`) — what the library index
 * holds and how its runs go, for the System settings.
 */
export interface LibraryIndexStatus {
  libraries: LibrarySummary[]
  /** Last indexing run, when one finished. */
  lastRun?: LibraryIndexRun
  /** Whether the server indexes libraries at all (a store with `libraries` and the setting on). */
  enabled: boolean
  /** The run going on now, when there is one. */
  progress?: LibraryIndexProgressView
  /** Per source, how far the listed libraries' versions are indexed. */
  coverage: LibrarySourceCoverage[]
}

/** A library index run going on now, as the scheduler leader last wrote it. */
export interface LibraryIndexProgressView {
  startedAt: Timestamp
  /** Libraries the run goes through, and how many it finished. */
  total: number
  done: number
  /** `<ecosystem>:<name>` the run works on: the first of `libraries`. */
  library?: string
  /** Every library the run works on now, when it indexes several at a time. */
  libraries?: string[]
  /** Set while every GitHub token is used up and the run waits for the reset. */
  waitingUntil?: Timestamp
  updatedAt: Timestamp
}

/**
 * How many versions in the matrix (libraries, for library-wide sources such as `issues`) have a
 * source in each state; `pending` ones were not fetched yet.
 */
export interface LibrarySourceCoverage {
  source: string
  ok: number
  missing: number
  failed: number
  skipped: number
  pending: number
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

/**
 * `GET /api/dependencies/docs?q=&ecosystem=&name=&version=&limit=` — matching chunks of libraries
 * readable repositories use, best first.
 */
export interface LibrarySearchResult {
  hits: { chunk: LibraryChunk; score: number }[]
}

/** `POST /api/system/library-index/reindex` (global `analyses:run`) — starts a run unless one is going. */
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

/** `GET /api/system/library-index/github?days=30` (global `settings:read`) — use and limits of the GitHub tokens. */
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

/** What a Home row points at: a repository (`forge:path`) and the groups the config gives it. */
export interface HomeRepoRef {
  repo: string
  groups: string[]
}

/** The rule that raised a Needs-attention item. */
export type HomeAttentionKind =
  | 'job-failures'
  | 'budget-blocked'
  | 'vulnerabilities'
  | 'allowlist'
  | 'release'
  | 'learnings'
  | 'knowledge'
  | 'stale-analyses'

/** How urgent a Needs-attention item is; the list is sorted by it, most urgent first. */
export type HomeSeverity = 'critical' | 'high' | 'medium' | 'low'

/** One row of Needs attention: a plain sentence, where it applies and a link to act on it. */
export interface HomeAttentionItem {
  /** Stable across reloads while the cause stays the same. */
  id: string
  kind: HomeAttentionKind
  severity: HomeSeverity
  title: string
  detail?: string
  /** Repositories it concerns; empty for items that belong to no repository. */
  repos: HomeRepoRef[]
  /** How many things the row stands for (jobs, findings, proposals, ...). */
  count: number
  /** When it started or was last seen, for the age. */
  at: string
  /** Web UI path to act on it, query string included. */
  href: string
}

/** Areas of What changed, each a group of History actions. */
export type HomeChangeKind =
  | 'release'
  | 'deploy'
  | 'settings'
  | 'knowledge'
  | 'guide'
  | 'repo'
  | 'credentials'
  | 'access'

/** History events of one area and repository over the window, summed. */
export interface HomeChange {
  kind: HomeChangeKind
  /** A deterministic sentence, e.g. `2 versions cut`. */
  text: string
  /** Absent for instance-level events. */
  repo?: HomeRepoRef
  count: number
  /** Principal ids, most recent first. */
  actors: string[]
  firstAt: string
  lastAt: string
}

/** This week's AI spend against the budget that covers everything the caller may read. */
export interface HomeSpend {
  /** The budget the bar measures, or `default` for the implicit one. */
  budgetId: string
  week: { from: string; to: string }
  spentUsd: number
  weeklyUsd: number
  /** Kept for interactive work: automatic work stops at `weeklyUsd - reserveUsd`. */
  reserveUsd: number
  projectedUsd: number
  action: 'block' | 'warn'
  /** Spend by task kind (`review`, `chat`, ...) over the caller's readable usage, largest first. */
  byFeature: { feature: string; costUsd: number; runs: number }[]
}

/** One status tick of a repository tile. */
export interface HomeRepoStatus {
  key: 'jobs' | 'vulnerabilities' | 'release' | 'analyses'
  tone: 'ok' | 'warning' | 'danger' | 'info' | 'none'
  label: string
}

/** A repository tile of the Home grid. */
export interface HomeRepoTile extends HomeRepoRef {
  /** Always in `HomeRepoStatus.key` order: jobs, vulnerabilities, release, analyses. */
  status: HomeRepoStatus[]
}

/**
 * `GET /api/home`: the Home page in one read, built from stored data only (no forge calls) and
 * filtered by the caller's permissions: job items and analyses need `analyses:read`, vulnerability
 * items `audits:read`, release items `releases:read`, learnings and knowledge proposals
 * `knowledge:write` where they would be decided, changes what History shows the caller, spend
 * `ai:read`. Scoping to the viewer's teams is left to the client: every row names its
 * repositories and their groups.
 */
export interface HomeView {
  generatedAt: string
  attention: HomeAttentionItem[]
  /** History of the last `changesDays` days, newest first. */
  changes: HomeChange[]
  changesDays: number
  /** Absent without `ai:read`. */
  spend?: HomeSpend
  repos: HomeRepoTile[]
  /** Names and avatars of the users among `changes` actors. */
  people: Record<string, PersonView>
}

/** One repository's part of a task group, as the API shows it. The patch is left out. */
export type AgentTaskView = Omit<AgentTask, 'patch'> & {
  /** The branch the task pushes, the same in every repository of its group. */
  branch: string
  /**
   * What the caller may do with this task now: `retry` a failed or cancelled one (`tasks:run` on
   * its repository), `cancel` one that has not opened a merge request or ended.
   */
  can: { retry: boolean; cancel: boolean }
}

/** A task group with its tasks and derived status. */
export interface AgentTaskGroupView extends Omit<AgentTaskGroup, 'patch'> {
  status: AgentTaskStatus
  tasks: AgentTaskView[]
  /** Sum of the tasks' agent spend in USD. */
  costUsd: number
  /** Whether the group carries a patch for the `git apply -3` fast path. */
  hasPatch: boolean
  /** What the caller may do with it now. */
  can: { approve: boolean; cancel: boolean }
}

/** `GET /api/task-groups`: newest first. */
export interface AgentTaskGroupList {
  groups: AgentTaskGroupView[]
  /** Names and avatars of the proposers, approvers and requesters among `groups`. */
  people: Record<string, PersonView>
}

/** `GET /api/task-groups/:id`: one group with the people it names. */
export interface AgentTaskGroupDetail extends AgentTaskGroupView {
  people: Record<string, PersonView>
  /** The patch approvers run with the group, in full. */
  patch?: string
  /** Patches of tasks that carry their own (task id → patch), e.g. the bumps of a rollout's fixes. */
  taskPatches?: Record<string, string>
}

/**
 * `GET /api/write-tasks`: the `tasks.write` switch and caps, and how the write worker pool is
 * doing, read from write task jobs (workers keep no registry). `spentUsd` needs `ai:read` or
 * `settings:read` over everything; `pool.workers` needs `settings:read` over everything.
 */
export interface WriteTasksStatus {
  enabled: boolean
  perRepoUsd: number
  perGroupUsd: number
  weeklyUsd: number
  maxRepos: number
  /** Write task spend in the current week, in USD. */
  spentUsd?: number
  pool: {
    queued: number
    running: number
    /** When the oldest queued write task was queued. */
    oldestQueuedAt?: string
    /** When a write worker last started a task. */
    lastStartedAt?: string
    /** Ids of the workers running write tasks now. */
    workers?: string[]
  }
}

/** `POST /api/task-groups`: proposes a change to one or more repositories. */
export interface AgentTaskGroupInput {
  kind?: AgentTaskKind
  title: string
  /** What the agent should do; not needed with `patch`. */
  prompt?: string
  plan?: string
  patch?: string
  /** `forge:path` of every target. */
  repos: string[]
  /** Approve and queue right away (needs `tasks:run` on every target). */
  run?: boolean
  /** Where the request came from; chat sources are set by the server only. */
  source?: Exclude<AgentTaskSource, { type: 'chat' }>
}
