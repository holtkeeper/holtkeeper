import type { Action, Grant, GroupMatch, Principal, Role, Scope } from '@holtkeeper/access'
import type { TranscriptLine } from '@holtkeeper/agent'
import type { ApiPackage, ApiSymbol, PackageDiff } from '@holtkeeper/api-surface'
import type {
  AssetKind,
  AssetProblem,
  AssetRow,
  AssetsPolicy,
  AssetsSummary,
} from '@holtkeeper/assets'
import type { AuthInfo } from '@holtkeeper/auth'
import type { BudgetVerdict, BundlePoint, BundleSeries, TargetSource } from '@holtkeeper/bundles'
import type { Conflict, FileDiff } from '@holtkeeper/changes'
import type { Card } from '@holtkeeper/chat'
import type { CiJobsData, CiProblem, CiProblemKind, CiStatus } from '@holtkeeper/ci-jobs'
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
  ReleaseProvenance,
  ReleaseSettings,
  ReleaseStage,
  ReleaseVersion,
  ReleaseVersionDetail,
  VersionTag,
} from '@holtkeeper/release'
import type { Metric, Report } from '@holtkeeper/report'
import type {
  AgentTask,
  AgentTaskCi,
  AgentTaskDiffstat,
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
  ChatMessageRef,
  Family,
  GuideGenerated,
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
  JobStatus,
  JobTrigger,
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
import type { AllowlistEntry, Severity } from '@holtkeeper/vuln'

/** Error body of every non-2xx JSON response. */
export interface ApiError {
  error: string
}

/**
 * Body of every 403 from `/api` and the MCP tools: the action the request needed and, for a
 * repository, the repo key exactly as the client sent it. It never names groups or grants and
 * reads the same whether that repository exists or the caller may not see it.
 */
export interface ForbiddenError extends ApiError {
  missing: { action: Action; target?: string }
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
  /** The running release, `HOLTKEEPER_VERSION` (a version or commit); absent when unknown. */
  version?: string
  /** The instance's own address (`server.publicUrl`), when configured. */
  publicUrl?: string
  /**
   * Display titles of the titled config groups the principal may know about, by group key: every
   * group with global `settings:read`, otherwise the groups its grants name and the groups of the
   * repositories it may list; empty when signed out. Show the title wherever a group is shown to
   * people; the key stays the identity.
   */
  groupTitles: Record<string, string>
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
   * Groups the *My teams* scope shows. A UI default, never a permission: the groups in the
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

/**
 * Where a finding stands in one repository: `open`, `fixing` while an agent task that fixes it is
 * not finished, or `allowlisted` by an entry that has not expired.
 */
export type FindingStatus = 'open' | 'fixing' | 'allowlisted'

/** One repository whose newest audit reports a finding group. */
export interface FindingRepo {
  /** `forge:path`. */
  repo: string
  /** Config groups of the repository, for folding other teams. */
  groups: string[]
  /** Affected versions installed there. */
  versions: string[]
  /** Lockfiles or manifests they were found in. */
  sources: string[]
  status: FindingStatus
  /** The agent task fixing it; set exactly when `status` is `fixing`. */
  taskId?: string
}

/** One advisory affecting one package, across the repositories the caller may read audits of. */
export interface FindingGroup {
  /** Primary advisory id, e.g. `GHSA-xxxx-xxxx-xxxx`. */
  advisory: string
  /** Other ids of the advisory, such as CVE numbers. */
  aliases: string[]
  summary?: string
  url?: string
  package: string
  /** OSV ecosystem name: `npm`, `Go`, `PyPI`, ... */
  ecosystem: string
  severity: Severity
  /** Versions that fix it, lowest first; empty when there is no fix. */
  fixedIn: string[]
  /** Never empty. */
  repos: FindingRepo[]
  /**
   * `open` when some repository has it open, otherwise `fixing` when some repository has a fix
   * task running, otherwise `allowlisted`.
   */
  status: FindingStatus
  /** A task fixing it; set exactly when `status` is `fixing`. */
  taskId?: string
  /**
   * When an audit of any of these repositories first reported it; the record time where no first
   * sighting was stored.
   */
  firstSeenAt: Timestamp
}

/**
 * `GET /api/audits/findings` — the findings of the newest audit of every repository the caller may
 * read audits of (`audits:read`), one group per advisory and package. Read from stored metrics.
 */
export interface FindingsResponse {
  /** Worst severity first, then most repositories, then advisory id. */
  groups: FindingGroup[]
  /** Groups per severity, every status included. */
  severities: SeverityCounts
}

/**
 * A package's verdict under its repository's license policy: `unlisted` needs review (not on the
 * allow list), `unknown` has no recognizable license, `internal` is defined by an analyzed
 * repository, `ignored` is left out by the policy.
 */
export type LicenseVerdictName =
  | 'allowed'
  | 'unknown'
  | 'unlisted'
  | 'denied'
  | 'ignored'
  | 'internal'
  | 'excepted'

/** Changes of one count since the week-old comparison point. */
export interface LicenseDelta {
  /** Packages that newly reached the verdict. */
  added: number
  /** Packages that left it. */
  resolved: number
}

/** One package whose license a policy denies or wants reviewed, across readable repositories. */
export interface LicenseViolation {
  package: string
  /** OSV ecosystem name. */
  ecosystem: string
  versions: string[]
  /** License expressions as declared; empty when none is known. */
  licenses: string[]
  /** The worst verdict any of its repositories gives it. */
  verdict: 'denied' | 'unlisted' | 'unknown'
  /** Licenses or policy patterns responsible for the verdict. */
  culprits: string[]
  /** Only dev dependency groups use it, in every repository. */
  dev: boolean
  repos: { repo: string; groups: string[] }[]
}

/** One repository's newest license scan, counted per verdict. */
export interface LicensesRepoRow {
  /** `forge:path`. */
  repo: string
  groups: string[]
  analysisId: string
  createdAt: Timestamp
  /** Third-party packages, internal ones left out. */
  packages: number
  verdicts: Record<LicenseVerdictName, number>
  /** `missing` only when the policy requires a license file and the repository has none. */
  licenseFile: 'present' | 'missing' | 'not-required'
}

/** A package the license policy accepts although its license would not pass. */
export interface LicenseExceptionView {
  /** Package name; `*` wildcards allowed. */
  package: string
  version?: string
  /** The declared license expression it accepts; absent: any. */
  license?: string
  reason: string
  approvedBy?: string
  /** Last day it applies, `YYYY-MM-DD`. */
  expires?: string
}

/**
 * The parts of the organization's license policy beyond allow, deny and ignore.
 */
export interface LicensePolicyRules {
  /** Licenses that need a sign-off even when allowed. */
  review: string[]
  /** `ignore`: packages only dev dependency groups use are not judged. */
  devDependencies: 'check' | 'ignore'
  exceptions: LicenseExceptionView[]
}

/** The license policy that applies to the caller's repositories when no narrower entry does. */
export interface LicensePolicySummary extends LicensePolicyRules {
  /** Label of the preset the options match, when they match one. */
  preset?: string
  allow: string[]
  deny: string[]
  ignore: string[]
  unknown: 'warn' | 'violation'
  requireProjectLicense: boolean
  /** Settings entries narrower than the organization's that override it for some repositories. */
  overrides: number
  updatedAt?: Timestamp
  updatedBy?: string
}

/**
 * `GET /api/licenses` — the newest license scan of every repository the caller may read analyses
 * of: totals, license mix, violations, a row per repository, the policy and changes over the past
 * week. Read from stored metrics.
 */
export interface LicensesOverview {
  kpi: {
    /** Third-party packages added up over repositories: one used by two repositories counts twice. */
    packages: number
    repos: number
    denied: number
    /** Packages needing review: `unlisted`. */
    review: number
    unknown: number
    /** Distinct license expressions. */
    licenses: number
    /** Of those, the ones the policy allows. */
    allowedLicenses: number
    /** Internal packages added up over repositories. */
    internal: number
    /** Repositories whose policy requires a license file they lack. */
    missingLicenseFile: number
  }
  /** Packages per license expression, added up over repositories, most first; `UNKNOWN` for none. */
  mix: { license: string; packages: number }[]
  /** Denied first, then unlisted, then unknown; then most repositories. */
  violations: LicenseViolation[]
  repos: LicensesRepoRow[]
  /** Only for callers who may read the organization's `analyzers.licenses` entry (`settings:read`). */
  policy?: LicensePolicySummary
  /** Against each repository's newest scan at least a week old; absent when there is none. */
  deltas?: {
    since: Timestamp
    denied: LicenseDelta
    review: LicenseDelta
    unknown: LicenseDelta
  }
}

/** Tone of a health cell: `none` when there is nothing to judge (no record, not set up). */
export type HealthTone = 'ok' | 'warn' | 'bad' | 'info' | 'none'

/** One health cell: a short value (`72%`, `1 high`), a detail line (may be empty) and its tone. */
export interface RepoHealthCell {
  value: string
  sub: string
  tone: HealthTone
}

/**
 * The health cells of a repository. Each one needs a permission on the repository: `security`
 * `audits:read`, `release` `releases:read`, every other one `analyses:read`.
 */
export type RepoHealthCellKey =
  | 'security'
  | 'dependencies'
  | 'coverage'
  | 'bundles'
  | 'jobs'
  | 'ci'
  | 'licenses'
  | 'release'

/** The cells a caller may read; cells it may not read are absent, never empty. */
export type RepoHealthCells = Partial<Record<RepoHealthCellKey, RepoHealthCell>>

/**
 * Overall state over the cells the caller may read: `failing` when one is `bad`, `warnings` when
 * one is `warn`, `not-analysed` when none has anything to judge, `healthy` otherwise.
 */
export type RepoHealthStatus = 'healthy' | 'warnings' | 'failing' | 'not-analysed'

/** How many of a repository's newest records (one per kind) are recent enough to count as current. */
export interface RepoFreshness {
  current: number
  total: number
}

/** How a repository learns about forge changes, in short. */
export interface RepoUpdatesSummary {
  /** `webhook`: deliveries arrived lately; `polling`: polled on its interval; `off`: neither. */
  via: 'webhook' | 'polling' | 'off'
  /** Polling interval in effect, when polled. */
  intervalMs?: number
  lastPolledAt?: Timestamp
  /** Error of the last poll, when it failed. */
  lastError?: string
}

/** One repository Holtkeeper knows about, with its health. */
export interface RepoSummary {
  repo: RepoRef
  groups: string[]
  /** Set when the caller holds `settings:write` on this repository. */
  configurable?: true
  health: RepoHealthStatus
  cells: RepoHealthCells
  /** Absent without `analyses:read`. */
  freshness?: RepoFreshness
  /** When the newest record was stored; absent without records or without `analyses:read`. */
  lastAnalysedAt?: Timestamp
  /** Absent without `settings:read` on this repository (or a scope covering it). */
  updates?: RepoUpdatesSummary
  /** The newest audit run, when the caller holds `audits:read`. */
  latestAudit?: AuditRunSummary
  /** Set when `repo.tests` says the repository has no tests by design. */
  noTests?: { reason?: string }
}

/**
 * `GET /api/repos`: every member of the configured groups as the last stored listings name them
 * (plus exact include paths), that the caller may read, sorted by `forge:path`.
 */
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
  /**
   * Present while `title` is a placeholder: the thread was created without a title and is named
   * from its first message shortly after it is posted.
   */
  titlePending?: true
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
  /** Messages in the thread, every author counted. */
  messageCount: number
  /**
   * Repositories (`forge:path`) attached as context that the caller may read, in the thread's
   * order; the others are left out without a trace.
   */
  contextRepos: string[]
  /** The caller muted the thread: it never counts toward their unread badge. Per person. */
  muted: boolean
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
  /**
   * What the message refers to, as stored with it (never parsed from the body), minus refs whose
   * `repo` the caller may not read; empty when nothing.
   */
  refs: ChatMessageRef[]
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

/**
 * `GET /api/chat/threads?archived=&q=` — threads the caller can see, newest activity first, and
 * the commands. `q` keeps threads whose title contains it, ignoring case.
 */
export interface ChatThreadList {
  threads: ChatThreadView[]
  commands: ChatCommandView[]
  /** Config groups the caller may start a group thread in. */
  groups: string[]
  /** Archived threads the caller can see that match `q`; counted whatever `archived` asked for. */
  archivedCount: number
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

/**
 * `POST /api/chat/threads` — a new thread, optionally about one repository or group, with
 * repositories (`forge:path`) attached as context; each must be readable by the caller (403).
 */
export interface ChatThreadInput {
  /**
   * Optional: when missing or blank the thread starts with a placeholder title (`titlePending`)
   * and the server names it from its first message, in that message's language, at most 60
   * characters. A title set later with `PATCH` is never replaced.
   */
  title?: string
  repo?: string
  group?: string
  autoReply?: boolean
  contextRepos?: string[]
}

/**
 * `PATCH /api/chat/threads/:id`. `contextRepos` replaces the repositories the caller can read and
 * keeps those they cannot see, so nobody drops context they never saw; each given repository must
 * be readable by the caller (403). `muted` applies to the caller only.
 */
export interface ChatThreadPatchInput {
  title?: string
  archived?: boolean
  autoReply?: boolean
  contextRepos?: string[]
  muted?: boolean
}

/** One human author in a thread's context column, with how many messages they wrote. */
export interface ChatContextParticipantView extends ChatParticipantView {
  messages: number
}

/**
 * `GET /api/chat/threads/:id/context` — totals over the whole thread for its context column.
 * Answers 404 for threads the caller cannot see.
 */
export interface ChatThreadContextView {
  messageCount: number
  /** Sum of the messages' AI cost; present only when the caller holds `ai:read`. */
  costUsd?: number
  /**
   * Repositories the thread is about that the caller may read: its context repositories first,
   * then those its messages refer to, in order of first mention.
   */
  repos: string[]
  /** Repositories of the thread the caller may not read; only their number is told. */
  hiddenRepoCount: number
  /** Calls per tool over every agent reply, most calls first. */
  tools: ChatToolUseView[]
  /** Human authors in order of their first message. */
  participants: ChatContextParticipantView[]
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
  /** What refers to the credential: forges, settings, trackers, webhooks. Absent when unknown. */
  usedBy?: CredentialUseView[]
  /** When something last used the secret (recorded at most once a minute). */
  lastUsedAt?: Timestamp
  createdAt: Timestamp
  updatedAt: Timestamp
}

/** One thing that refers to a credential, e.g. a panel forge or the `llm.provider` setting. */
export interface CredentialUseView {
  /** `forge`, `setting`, `tracker`, `webhook`, ... */
  kind: string
  /** The forge id, setting key, tracker id, ... */
  id: string
  label: string
  /** Web UI path that opens it, built with `webPaths`. */
  href?: string
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
  /** What applies where no entry covers a repository; `null` when nothing applies until set. */
  default: unknown
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

/**
 * Layers a resolved value comes from, broad to narrow, a narrower one winning: the definition's
 * `default`, an entry scoped `{ all: true }` (`org`), an entry reaching the focus through its
 * groups (`group`), an entry naming the repository by path or path glob (`repo`).
 */
export type SettingLayer = 'default' | 'org' | 'group' | 'repo'

/** Where a resolved value comes from. */
export interface SettingSource {
  layer: SettingLayer
  /** For `group`: the focus's groups the entry's scope matched on, e.g. `['payments']`. */
  groups?: string[]
  /** The entry; absent for `default`. */
  entry?: SettingView
}

/**
 * One key of the resolver: the single source that applies to the focus as a whole and the one it
 * replaces. `analyzers.<kind>` is one row per analyzer whose entry applies whole; values are not
 * merged field by field.
 */
export interface ResolvedSettingRow {
  key: string
  /** The definition's label. */
  label: string
  /** The definition's category (`SettingDefinitionView.section`), for grouping rows. */
  section: string
  /** The winning entry's value, or the definition's `default` without an entry. */
  value: unknown
  /** The winner. */
  source: SettingSource
  /** The next broader source the winner replaces with its value; absent when the default applies. */
  replaces?: SettingSource & { value: unknown }
  /** The entry that applies as a whole (`source.entry`); absent when the default applies. */
  entry?: SettingView
  /** Broader covering entries `entry` overrides. */
  overrides: number
}

/**
 * `GET /api/settings/resolve?repo=forge:path` or `?group=<id>` — the winning entry per key and what
 * it overrides, for one repository or for a repository of the group that no narrower entry names.
 * Exactly one of `repo` and `group` is set, echoing the focus.
 */
export interface ResolvedSettings {
  repo?: RepoRef
  group?: string
  /** Config groups of the repository; `[group]` for a group focus. */
  groups: string[]
  settings: Record<string, SettingView>
  /**
   * Every entry covering the repository per key, the one that applies first, then the ones it
   * overrides from narrow to broad.
   */
  cascade: Record<string, SettingView[]>
  /**
   * One row per setting the server defines, in definition order: only keys that exist, retired and
   * secret keys left out. `global` keys only ever show the `org` or `default` source.
   */
  rows: ResolvedSettingRow[]
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
  /** Config groups of the repository, for the scope switch. */
  groups: string[]
  /** Worst state of the repository's CI in the record's window. */
  status: CiStatus
  /** Jobs that passed only on retry in the window. */
  flakyJobs: number
  /** Median queue time of job attempts, seconds; absent when no attempt reported one. */
  queueMedian?: number
  /**
   * Whether releases require a passing pipeline, and on which branch. Present only for callers
   * with `releases:read` on the repository and only while releases are on for it.
   */
  releaseGate?: CiReleaseGate
}

/** The release gate a CI card mentions: `pipeline` is on when a failed or canceled pipeline on `branch` blocks release steps. */
export interface CiReleaseGate {
  pipeline: boolean
  branch: string
}

export type { CiStatus }

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

/** Final attempts of a job (or of every job) by how they ended. */
export interface CiJobOutcomes {
  success: number
  failed: number
  canceled: number
}

/** One job of one repository on the CI jobs table. Durations are seconds. */
export interface CiJobRow {
  name: string
  stage: string
  /** Attempts, retried ones included. */
  runs: number
  outcomes: CiJobOutcomes
  /** Median and p90 of successful attempts. */
  median?: number
  p90?: number
  /** Percent change of the recent median against the earlier part of the window. */
  change?: number
  /** Percent of final attempts, allowed failures left out, that failed. */
  failureRate?: number
  /** Pipelines where an attempt failed and a retry passed. */
  flaky: number
  allowFailure: boolean
  /** Problems the problem list sees in the job; empty when it has none. */
  problems: CiProblemKind[]
  last?: { at: Timestamp; status: string; href: string }
}

/**
 * `GET /api/ci/jobs?repo=` — the jobs of one repository the caller may read, over a bounded time
 * range. `jobs` holds at most a fixed number of rows; `total` counts every job of the range, so
 * `total > jobs.length` means rows were left out.
 */
export interface CiJobsView {
  repo: RepoRef
  /** The range the rows describe: attempts created at or after `from` and before `to`. */
  range: { from: Timestamp; to: Timestamp }
  /** Branch the rows describe; every ref when absent. */
  ref?: string
  jobs: CiJobRow[]
  total: number
  /** Sums over every job of the range, not only the rows returned. */
  outcomes: CiJobOutcomes
}

/** How `GET /api/ci/jobs/fleet` ranks jobs: slowest median, highest failure rate, most slowed down. */
export type CiFleetJobSort = 'slowest' | 'unreliable' | 'slower'

/** One job of the fleet jobs table, with the repository it runs in. */
export interface CiFleetJobRow extends CiJobRow {
  repo: RepoRef
}

/**
 * `GET /api/ci/jobs/fleet?sort=&limit=` — jobs of the newest `ci-jobs` record of every repository
 * the caller may read, ranked by `sort`; at most a fixed number of rows. `total` counts every job
 * the ranking considered; `slower` keeps only jobs whose median grew, `unreliable` only jobs that
 * failed or passed on retry.
 */
export interface CiFleetJobsView {
  sort: CiFleetJobSort
  jobs: CiFleetJobRow[]
  total: number
  /** Repositories whose records were read. */
  repos: number
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
  /**
   * Line coverage the repository should reach, from the `analyzers.coverage` entry that applies to
   * it; set only by `/coverage` and only when that entry sets `target`.
   */
  target?: number
  /** Coverage of the files that changed since the previous record; set only by `/coverage/repo`. */
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
  /** The job that produced the card's record; absent for uploads, pruned jobs or without access. */
  job?: AnalysisJobSummary
  /**
   * How `repo.tests` applies: present when tests are not expected, or when the caller may change
   * it for this repository (`configurable`).
   */
  tests?: RepoCoverageTests
}

/** `repo.tests` for one repository, as `GET /api/coverage/repo` describes it. */
export interface RepoCoverageTests {
  expected: boolean
  reason?: string
  /** Scope of the entry that decides it; absent for the default or without `settings:read` on it. */
  scope?: Scope
  /**
   * Id of the repository's own entry (scoped to exactly `forge:path`), whether or not it decides;
   * only for `configurable` callers and only when such an entry exists.
   */
  entryId?: string
  /** What applies once that own entry is removed; set together with `entryId`. */
  inherited?: boolean
  /** Set when the caller may write `repo.tests` for exactly this repository and its own entry. */
  configurable?: true
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

/** Headline numbers of one repository's newest assets record, from its stored metrics. */
export interface AssetsRepoSummary {
  repo: RepoRef
  /** Config groups of the repository, for the scope switch. */
  groups: string[]
  analysisId: string
  createdAt: Timestamp
  files: number
  bytes: number
  /** Bytes per kind; only kinds that have files. */
  kinds: Partial<Record<AssetKind, number>>
  errors: number
  warnings: number
  /** Exceeded budgets over every file or a kind. */
  budgets: number
  /** Bytes every suggestion together would save. */
  savings: number
  duplicateBytes: number
  /** `bytes` minus the previous record's; absent without one. */
  delta?: number
  /** File rows the stored metrics left out, so neither filters nor `total` see them. */
  moreRows: number
}

/** One file on the fleet Assets table: a row of its repository's newest assets record. */
export interface AssetsOverviewRow extends AssetRow {
  repo: RepoRef
  analysisId: string
}

/** Which files the Assets table lists: those that break the policy, those with a saving, or both. */
export type AssetsStatusFilter = 'policy' | 'saving' | 'any'

/** How the Assets table orders files; every order breaks ties by repository and path. */
export type AssetsSort = 'severity' | 'saving' | 'size'

/**
 * Query of `GET /api/assets`. Filters combine; an absent filter matches everything. `cursor` is
 * the `nextCursor` of the previous page under the same filters and sort.
 */
export interface AssetsQuery {
  /** Config group name. */
  group?: string
  /** `forge:path`. */
  repo?: string
  status?: AssetsStatusFilter
  kind?: AssetKind
  /** Only files with a problem of this rule (a policy rule, `duplicate` or `saving`). */
  problem?: AssetProblem['rule']
  format?: string
  sort?: AssetsSort
  cursor?: string
  /** Rows per page; the server caps it. */
  limit?: number
}

/**
 * `GET /api/assets` — the files to act on across the repositories the caller may read, one page
 * at a time. `repos` summarizes every readable repository that matches `group` and `repo`,
 * whatever the other filters; `items` is one page of matching files in the requested order;
 * `total` counts every matching file; `nextCursor` is present exactly when more pages follow.
 */
export interface AssetsOverview {
  repos: AssetsRepoSummary[]
  items: AssetsOverviewRow[]
  total: number
  nextCursor?: string
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
  /** The job that produced the record; absent for uploads and once the job is pruned. */
  job?: AnalysisJobSummary
}

/** The job behind an analysis record, as the record page shows it. */
export interface AnalysisJobSummary {
  id: string
  status: JobStatus
  trigger: JobTrigger
  analyzer: string
  createdAt: Timestamp
  finishedAt?: Timestamp
  /** Error of the latest failed attempt. */
  error?: string
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
  /** Release lines of the product as the lifecycle source lists them; absent when none is known. */
  cycles?: StackCycle[]
  uses: StackUse[]
}

/** One release line of a stack component's lifecycle, as recorded when the analysis ran. */
export interface StackCycle {
  /** Release line, e.g. `22`, `1.23`, `24.04`. */
  cycle: string
  releaseDate?: string
  /** End of life: a date, `true` when ended without a known date, `false` when none is planned. */
  eol: string | boolean
  /** Long-term support: `true`, or the date the line entered it. */
  lts?: string | boolean
  /** Newest release of the line. */
  latest?: string
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

/** One library of `GET /api/dependencies/search`. */
export interface DependencySearchHit {
  ecosystem: LibraryEcosystem
  name: string
  internal: boolean
  latest?: string
  /** Readable repositories using it. */
  usedBy: number
}

/**
 * `GET /api/dependencies/search?q=&limit=` — libraries the readable repositories use whose name
 * contains `q` (case-insensitive): name prefixes first, then the most used, at most `limit`
 * (default 10, at most 50).
 */
export interface DependencySearchResult {
  libraries: DependencySearchHit[]
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
 * requests, the indexed versions and the documents of the newest indexed one. An internal package
 * that only the public API catalog knows is found too, with empty lists. Upgrade readiness is not
 * part of it: it loads on demand from `GET /api/dependencies/upgrade`.
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
  /** Empty for an internal package no readable repository depends on yet. */
  usedBy: {
    repo: RepoRef
    groups: string[]
    versions: string[]
    majorsBehind: number
  }[]
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
    documents: {
      source: LibraryChunk['source']
      path: string
      chunks: number
    }[]
  }
}

/**
 * `GET /api/dependencies/api?ecosystem=&name=` — the API tab of one library: where an internal
 * package is defined and how much of its public API is exported and documented, per entry point.
 */
export interface DependencyApi {
  ecosystem: LibraryEcosystem
  name: string
  /** The newest public API record defining an internal package; absent for third-party libraries. */
  definedIn?: { repo: RepoRef; ref?: string; analysisId: string }
  /** Version the counts describe. */
  version?: string
  /** Absent when no public API of the library is on record. */
  api?: { exports: number; documented: number }
  /** Entry point subpaths, `.` first; empty when none is on record. */
  subpaths: string[]
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
  artifacts?: {
    id: string
    base64: string
    contentType?: string
    name?: string
  }[]
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
  /** Principal id of who invited the user (`cli`, `bootstrap` for accounts not made by a person). */
  createdBy?: string
  /** The person behind `createdBy` when it is a user: the Account page's "Given by". */
  creator?: PersonView
  passkeys: {
    id: string
    label?: string
    createdAt: Timestamp
    lastUsedAt?: Timestamp
  }[]
  identities: { provider: string; email?: string }[]
  avatarUrl: string
  /** When the user last made a signed-in request (recorded at most once a minute). */
  lastSeenAt?: Timestamp
  /** The newest enrollment link while the user has never signed in. */
  invite?: UserInviteView
  /** The user's teams: their home groups, else the groups their grants name. */
  teams?: string[]
}

/** An enrollment link a user has not used yet. */
export interface UserInviteView {
  createdAt?: Timestamp
  expiresAt: Timestamp
  /** The link ran out; a new one has to be sent. */
  expired: boolean
  createdBy?: string
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

/** The role a link's grants read as (`roleOf` in `@holtkeeper/access`), shown before sign-in. */
export type LinkRole = Role

/**
 * `GET /auth/users/link/:token` — what a live, unused setup or recovery link is for. `grants`
 * gives only the number of grants and their role, never scopes, group names or who issued it.
 */
export interface LinkInfo {
  purpose: 'enroll' | 'recover'
  userName: string
  expiresAt: Timestamp
  grants: { count: number; role: LinkRole }
}

/** The 410 body of a used or expired link: when it was used or when it expired, nothing else. */
export interface LinkGone extends ApiError {
  state: 'used' | 'expired'
  at: Timestamp
}

/** `GET /api/jobs/:id` — a background analysis run with its attempts; the log is read apart. */
export type Job = StoredJob

/** A job as lists show it. */
export type JobSummary = StoredJob

/**
 * `GET /api/jobs?status=&repo=&repos=&analyzer=&trigger=&schedule=&signature=&analysisId=&q=&limit=&before=`
 * — newest first, only repositories the caller may read (filtered before `limit`). `repos` is a
 * comma list of `forge:path` (group jobs: `forge:<group>`); `signature` matches `errorSignature`
 * exactly; `analysisId` keeps the jobs that wrote that analysis; `q` (at most 200 characters)
 * keeps jobs whose id starts with it or whose repository path, group, analyzer kind or analyzer
 * label contains it, ignoring case. `people` resolves the jobs' actors that are users.
 */
export interface JobList {
  jobs: JobSummary[]
  people: Record<string, PersonView>
  /**
   * Why each queued job of `jobs` has not started (job id → `JobWait`), from the same claim rules
   * as `GET /api/jobs/:id/why`, so a list needs no request per row. Only queued jobs have an entry.
   */
  waitHints: Record<string, JobWait>
  /**
   * What the agent runs of each job of `jobs` cost so far in USD (job id → cost), counted only for
   * analyzers that use an agent and jobs whose target the caller may `ai:read` or `ai:admin`; jobs
   * without a cost (or whose cost the caller may not read) have no entry.
   */
  costs: Record<string, number>
}

/** A wait reason kind of `JobStats.waits`, or `capacity`: nothing but a free worker slot is missing. */
export type JobWaitKind = WaitReason['kind'] | 'capacity'

/** A worker that announced itself within the registry TTL, with the jobs it runs now. */
export interface JobWorkerView {
  id: string
  lastSeen: Timestamp
  running: number
}

/**
 * `GET /api/jobs/stats?repos=`: the queue at a glance, counted only over repositories (and groups)
 * the caller may `analyses:read`, narrowed further to `repos` (comma list of `forge:path`) when given. `queue.queued` and `queue.running` are live; `queue.failed` and
 * `queue.blocked` count jobs created in the last `windowHours`. `claimLatency` is the time from a
 * job becoming due (`runAfter`) to its latest claim, over jobs started in the window (percentiles
 * absent without samples). `waits` buckets the oldest queued jobs in claim order (at most 50,
 * `sampled` of them) by every reason holding each back. `running.costUsd` is what the running jobs'
 * agent runs spent so far, over those the caller may `ai:read` or `ai:admin`; absent without any AI
 * read permission. `workers` (live workers, most recently seen first) is present only for
 * callers with `analyses:read` over everything. MCP and chat `queue_stats` return the same numbers.
 */
export interface JobStats {
  at: Timestamp
  windowHours: number
  queue: { queued: number; running: number; failed: number; blocked: number }
  claimLatency: { samples: number; p50Ms?: number; p95Ms?: number }
  waits: { sampled: number; reasons: { kind: JobWaitKind; count: number }[] }
  running: { jobs: number; costUsd?: number }
  workers?: JobWorkerView[]
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
  /** Where the job's commands run (`jobs.execution.mode`): `host`, `mise` or `container`. */
  mode: 'host' | 'mise' | 'container'
  /** The spend cap of the job's agent runs in USD, when the job carries one (write tasks). */
  costCapUsd?: number
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
 * `GET /api/jobs/count?status=&repos=&analyzer=&trigger=&since=`: how many jobs match, counted only
 * over repositories (and groups) the caller may read, with the same filters as `JobList`
 * (`analysisId`, `repo`, `schedule`, `signature` and `q` too); `since`
 * counts jobs created at or after it. `byStatus` has every status, zero included, and sums to `total`.
 */
export interface JobCountView {
  total: number
  byStatus: Record<JobStatus, number>
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

/** What a caller may do with one repository's release, as `ReleaseCard.can` explains. */
export interface ReleaseCan {
  accept: boolean
  run: boolean
}

/** One repository on the Releases overview: its snapshot row plus whether a person should act. */
export type ReleaseCard = ReleaseBoardRow & {
  /**
   * A step is pending (candidate, proposed, awaiting a version), a deploy failed or is ready, or
   * reading failed; false while the waiting release is dismissed.
   */
  needsAction: boolean
  /**
   * The commit a decision about the waiting release names: the source branch head while a
   * candidate waits, else the target branch head. Absent when nothing waits or reading failed.
   */
  head?: string
  /**
   * What the caller may do with this repository's release now, computed per caller: `accept` the
   * target branch head and `run` steps and deploys both need exactly `releases:run` on the
   * repository; `accept` is also false when nothing waits for acceptance (no unreleased changes,
   * already accepted, a flow without acceptance, or reading failed).
   */
  can: ReleaseCan
  /**
   * Set while a person dismissed the waiting release and `head` is still the commit they
   * dismissed; a new commit ends it. `by` is a principal id resolved in `people`.
   */
  dismissed?: { sha: string; by: string; at: Timestamp }
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
  /** Principal id or forge username of who started it, resolved in `people` where known. */
  actor: string
  /** Display name of `actor` when it was recorded and differs from the id. */
  actorName?: string
  /** Why the newest deploy was started, when it was not a plain first deploy. */
  reason?: string
  url?: string
}

/** A past version on the timeline with its recorded deploys. */
export type ReleaseVersionView = ReleaseVersion & {
  deploys: ReleaseVersionDeploy[]
}

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
  /** As `ReleaseCard.can`, for `next`; `accept` is false without `next`. */
  can: ReleaseCan
  versions: ReleaseVersionView[]
  /** Versions in all; release candidates count only when the flow makes them. */
  total: number
  /** Offset of the next page while older versions remain. */
  nextOffset?: number
}

/**
 * `GET /api/releases/version?repo=&tag=`: one version in full (entries, changelog, tasks, compare
 * link) with its recorded deploys and, when environments are configured, the live deploy state
 * whose attempts started through Holtkeeper carry `actor` and `reason`. `provenance` says who
 * accepted and created the version, with the override, the source of the notes and the
 * `CHANGELOG.md` commit; absent when Holtkeeper did not create it. 404 when the tag is not a
 * version.
 */
export type ReleaseVersionDetailView = ReleaseVersionDetail & {
  deploys: ReleaseVersionDeploy[]
  deploy?: DeployState
  provenance?: ReleaseProvenance
  /** Users among the provenance and deploy actors, by id. */
  people: Record<string, PersonView>
}

/**
 * `GET /api/releases/detect?repo=`: the release flow suggested from what the repository already
 * does, read from the forge on each request and never kept in the snapshot. `configured` is true
 * when a `releases` setting already names the repository or one of its groups. Needs
 * `releases:read` on the repository.
 */
export interface ReleaseDetectView {
  repo: RepoRef
  detection: FlowDetection
  configured: boolean
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
  history: ReleaseEvent[]
  /** Forge pages of the release: merge requests, tags, diffs, pipelines, project lists. */
  links: ReleaseLink[]
  /** Users among the history's actors and the acceptance, by id. */
  people: Record<string, PersonView>
  /** What the caller may do here: `accept` and `run` as `ReleaseCard.can`, `configure` needs `settings:write`. */
  can: ReleaseCan & { configure: boolean }
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

/**
 * `POST /api/releases/dismiss`: hides the release waiting in `repo` from Inbox and Home until a new
 * commit arrives. `sha` is the card's `head`; the server answers 409 when the head moved since.
 * Nothing changes on the forge, and the dismissal holds for everyone. Needs `releases:run` on the
 * repository; audited as `release.dismiss`.
 */
export interface ReleaseDismissInput {
  repo: string
  sha: string
}

/** `POST /api/releases/deploy`: starts the deploy job of one environment for a version. */
export interface ReleaseDeployInput {
  repo: string
  tag: string
  environment: string
  redeploy?: boolean
  force?: boolean
  /** Why; kept on the deploy attempt and in the history. */
  reason?: string
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

/** One measurement of a target on the Bundles overview. */
export interface BundleSizePoint {
  analysisId: string
  createdAt: Timestamp
  status: 'ok' | 'failed'
  /** JS and CSS gzip bytes; absent when the measurement failed. */
  gzip?: number
}

/** One target's row on the Bundles overview, from stored metrics only. */
export interface BundleTargetRow {
  name: string
  source: TargetSource
  /** Newest version measured, for package targets. */
  version?: string
  /** Status of the newest measurement. */
  status: 'ok' | 'failed'
  /** JS and CSS gzip bytes of the newest measurement; absent when it failed. */
  gzip?: number
  /** Initial gzip bytes of the largest entrypoint. */
  initial?: number
  /** `gzip` minus the previous measurement's; absent without one. */
  delta?: number
  /** Maximum gzip bytes from the current `analyzers.bundle` options; absent without a budget. */
  budget?: number
  /** `gzip` against `budget`; absent without either. */
  verdict?: BudgetVerdict
  /** `verdict === 'over'`. */
  overBudget: boolean
  /** Measurements of the records read, oldest first, the newest included. */
  series: BundleSizePoint[]
  /** The record of the newest measurement. */
  analysisId: string
  createdAt: Timestamp
}

/** One repository on the Bundles overview: its targets from the newest bundle records. */
export interface BundlesRepoRow {
  repo: RepoRef
  /** Config groups of the repository, for the scope switch. */
  groups: string[]
  /** The newest record. */
  analysisId: string
  createdAt: Timestamp
  ref?: string
  /** Targets by name. */
  targets: BundleTargetRow[]
  /** Targets whose newest measurement failed. */
  failed: number
  /** Targets over budget. */
  overBudget: number
  /** Records read for the repository, at most a fixed small number (about 20). */
  records: number
}

/**
 * `GET /api/bundles` — repositories the caller may read that have a bundle record, each built from
 * the stored metrics of its newest records; record data is never read.
 */
export interface BundlesOverview {
  repos: BundlesRepoRow[]
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
    | {
        on: 'change'
        minInterval: string
        paths?: readonly string[]
        heavy?: boolean
      }
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

/** Overview cards of the repository hub, each opening its area of the Supply chain or Quality tab. */
export type RepoCardKey =
  | 'security'
  | 'libraries'
  | 'licenses'
  | 'stack'
  | 'public-api'
  | 'coverage'
  | 'bundles'
  | 'assets'
  | 'ci'
  | 'branches'

/** One part of a card's bar: `share` of the bar's width (0..1); `none` is drawn neutral. */
export interface RepoCardSegment {
  tone: HealthTone
  share: number
}

/**
 * One Overview card, formatted by the server like a health cell: `status` and its `tone` for the
 * tag (`Not analysed` with tone `none` when there is no record), the headline `value` with its
 * `unit`, up to two detail `lines`, and an optional bar whose segments add up to at most 1.
 */
export interface RepoOverviewCard {
  key: RepoCardKey
  section: 'supply' | 'quality'
  tone: HealthTone
  status: string
  value: string
  unit: string
  lines: string[]
  segments?: RepoCardSegment[]
  /** The record the card describes; absent without one. */
  analysisId?: string
}

/** Holtkeeper's merge request reviews of the last 30 days, summed. */
export interface RepoReviewTotals {
  reviews: number
  /** Comments the forge accepted. */
  posted: number
  /** Threads the reviews resolved. */
  resolved: number
  up: number
  down: number
  costUsd: number
}

/** Jobs and write tasks of the repository this week (since Monday 00:00 UTC). */
export interface RepoWorkSummary {
  runs: number
  failed: number
  /** Proposed write tasks waiting for a person to approve them; only with `repos:read`. */
  awaitingApproval?: number
  /** AI spend of those jobs and tasks; only with `ai:read` or `ai:admin`. */
  costUsd?: number
}

/** The repository's Guide as the Knowledge card shows it. */
export interface RepoKnowledgeSummary {
  /** Guide sections written for the repository itself. */
  sections: number
  notes: number
  /** Learnings proposed for the repository, waiting for review. */
  proposed: number
  /** Broader Guide scopes it inherits from, broad to narrow, e.g. `group web`, `family storefronts`. */
  inherits: string[]
}

/** The repository's release state from the Releases snapshot. */
export type RepoReleaseSummary = Pick<
  ReleaseBoardRow,
  'stage' | 'latest' | 'next' | 'bump' | 'unreleased' | 'unreleasedCapped'
> & {
  /** The newest successful deploy of the latest version. */
  deployed?: { environment: string; at: Timestamp }
}

/** One runtime or package manager the repository pins, e.g. `node` `18.20`. */
export interface RepoToolchainEntry {
  name: string
  version: string
}

/** What Holtkeeper may do in the repository. */
export interface RepoAccessSummary {
  /** Agents and analyzers only read; nothing writes to the forge. */
  readOnly: boolean
  /** Why it is read-only and until when, when someone said so. */
  reason?: string
  until?: Timestamp
  /** Write tasks may open merge requests there (`tasks.write` and not read-only). */
  writeTasks: boolean
}

/**
 * `GET /api/repos/overview?repo=` — what the repository hub's header and Overview show, from stored
 * records only: the health strip (`health`, `cells`, the same as `GET /api/repos`), the Supply chain
 * and Quality cards, the newest record of every analysis kind (reviews left out) for the freshness
 * table, the default-branch head freshness last saw, and the Delivery cards' data. Needs
 * `analyses:read`; every part behind another permission is absent without it (cells and cards
 * included), never empty. It never carries the head commit's title.
 */
export interface RepoOverview {
  repo: RepoRef
  groups: string[]
  health: RepoHealthStatus
  cells: RepoHealthCells
  /** Supply chain cards, then Quality cards, in display order. */
  cards: RepoOverviewCard[]
  /** The default-branch head freshness last saw; records on another sha are behind it. */
  head?: { sha: string; at: Timestamp }
  /** Default branch as the forge last reported it. */
  defaultBranch?: string
  analyses: AnalysisSummary[]
  audit?: AuditRunSummary
  /** Direct dependencies in the newest `depgraph` record. */
  dependencies?: { direct: number; analysisId: string; createdAt: Timestamp }
  stack?: RepoStackView
  /** Runtimes and package managers from the newest `stack` record; empty without one. */
  toolchain: RepoToolchainEntry[]
  reviews30d: RepoReviewTotals
  work: RepoWorkSummary
  /** Absent without `knowledge:read`. */
  knowledge?: RepoKnowledgeSummary
  /** Absent without `releases:read` or while releases are off for the repository. */
  release?: RepoReleaseSummary
  access: RepoAccessSummary
}

/** Posted review findings of one run per severity. */
export interface ReviewFindingCounts {
  info: number
  minor: number
  major: number
  critical: number
}

/** One review run on the fleet Reviews table, from the record's stored metrics. */
export interface ReviewRow {
  analysisId: string
  repo: RepoRef
  createdAt: Timestamp
  mergeRequest: { iid: number; title: string; url: string; author?: string }
  mode: 'full' | 'incremental' | 'reply' | 'skipped'
  verdict: 'looks-good' | 'needs-changes' | 'skipped'
  /** Findings the forge accepted, in total and per severity. */
  findings: number
  severities: ReviewFindingCounts
  /** Threads the run resolved. */
  resolved: number
  /** Model that ran the review; absent for records made before it was stored. */
  model?: string
  /** Wall time of the run; absent for records made before it was stored. */
  durationMs?: number
  /** Guide scopes the review read, broad to narrow; empty when unknown or none. */
  guideScopes: string[]
  costUsd?: number
}

/**
 * Query of `GET /api/reviews`: records created at or after `since` (default 30 days ago), newest
 * first, optionally of one repository or config group and of one verdict.
 */
export interface ReviewQuery {
  /** `forge:path`. */
  repo?: string
  group?: string
  verdict?: ReviewRow['verdict']
  since?: Timestamp
  /** Paging: only records created before this time. */
  before?: Timestamp
  limit?: number
}

/**
 * `GET /api/reviews` — review runs on repositories the caller may read, newest first. `reviews`
 * holds at most the requested (and capped) number of rows; `nextBefore` is present exactly when
 * older rows may follow and is the `before` of the next page.
 */
export interface ReviewList {
  reviews: ReviewRow[]
  /** Sums over `reviews`. */
  totals: {
    reviews: number
    findings: number
    resolved: number
    costUsd: number
  }
  /**
   * Sums over every review the same query matches in its window, not only this page; sent with
   * the first page (no `before`) only.
   */
  window?: ReviewWindowTotals
  nextBefore?: Timestamp
}

/** A Reviews window in figures, for the strip above the table. */
export interface ReviewWindowTotals {
  reviews: number
  verdicts: Record<ReviewRow['verdict'], number>
  findings: number
  severities: ReviewFindingCounts
  resolved: number
  costUsd: number
  /** The scan stopped at its cap before the window's start, so the figures are a lower bound. */
  partial?: true
}

/**
 * `GET /api/reviews/:id` — one review run: its row, the summary and the posted and rejected
 * findings. 404 when the record is not a review or the caller may not read its repository.
 */
export interface ReviewDetail {
  review: ReviewRow
  summary: string
  /** Head commit that was reviewed. */
  head: string
  sourceBranch: string
  targetBranch: string
  findings: ReviewFindingView[]
  /** Tokens the run used, when stored. */
  usage?: { inputTokens?: number; outputTokens?: number; turns: number }
}

/** One finding of a review run. */
export interface ReviewFindingView {
  id: string
  path: string
  line: number
  startLine?: number
  severity: keyof ReviewFindingCounts
  category: string
  title: string
  body: string
  /** `agent` or the quality check that found it. */
  source: string
  /** Whether the forge accepted it as a comment; `error` says why not. */
  posted: boolean
  error?: string
  href?: string
  suggestion?: { replacement: string; original?: string }
}

/** Why a branch is worth deleting. */
export type BranchCleanupReason = 'merged' | 'closed' | 'stale'

/** Branches worth deleting of one author in one repository's newest record. */
export interface BranchAuthorRow {
  /** Author of the head commit; `unknown` when the forge did not report one. */
  author: string
  cleanup: number
  merged: number
  closed: number
  stale: number
  /** Age in days of the author's oldest branch worth deleting. */
  oldestDays: number
}

/** One branch worth deleting, as the Branches table lists it. */
export interface BranchRow {
  name: string
  reason: BranchCleanupReason
  committedAt: Timestamp
  ageDays: number
  author?: string
  webUrl?: string
  mergeRequest?: {
    iid: number
    state: 'open' | 'merged' | 'closed'
    title: string
    url: string
  }
}

/** One repository on the Branches overview, from its newest `branches` record. */
export interface BranchesRepoRow {
  repo: RepoRef
  /** Config groups of the repository, for the scope switch. */
  groups: string[]
  analysisId: string
  createdAt: Timestamp
  defaultBranch: string
  staleDays: number
  /** Branches judged besides the default branch, and of them those with an open merge request. */
  total: number
  open: number
  /** Branches worth deleting, and how many for each reason. */
  cleanup: number
  merged: number
  closed: number
  stale: number
  oldestDays?: number
  /** Change of each count against the previous record's metrics; absent without one. */
  delta?: {
    total: number
    cleanup: number
    merged: number
    closed: number
    stale: number
  }
  /** Branches worth deleting per author, most first. */
  authors: BranchAuthorRow[]
  /** Branches worth deleting, oldest first, at most a fixed number; `more` counts the rest. */
  branches: BranchRow[]
  more: number
}

/** `GET /api/branches` — repositories the caller may read that have a `branches` record. */
export interface BranchesOverview {
  repos: BranchesRepoRow[]
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
      stats: {
        hits: number
        misses: number
        stored: number
        servedBytes: number
        errors: number
      }
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

/** Guide, Notes and Learnings totals of one Knowledge space. */
export interface KnowledgeSpaceCounts {
  /** Sections of the space with human rules or generated text. */
  guide: number
  /**
   * Live notes (proposed and accepted) the space's Notes table lists: every note the caller may
   * read for `all`, notes naming the group or any family member, and notes covering the
   * repository, inherited ones included.
   */
  notes: number
  /** Learning candidates still proposed for the space. */
  learnings: number
}

/**
 * `GET /api/knowledge/counts` — totals per Knowledge space, keyed by space (`all`, `group:<g>`,
 * `family:<id>`, `repo:<forge>:<path>`, the Guide scope keys). Only spaces whose scope the caller
 * may read are present; a space with nothing in it may be left out.
 */
export interface KnowledgeCounts {
  spaces: Record<string, KnowledgeSpaceCounts>
}

/** Where a layer of the Guide chain comes from, in the order the agent reads layers. */
export type GuideChainLayerKind =
  | 'repo-file'
  | 'repo'
  | 'family'
  | 'group'
  | 'all'
  | 'learnings'
  | 'policies'
  | 'generated'
  | 'notes'

/** One numbered layer of a section's Guide chain: the text the agent gets from one source. */
export interface GuideChainLayer {
  /** 1-based position in the section's chain. */
  n: number
  kind: GuideChainLayerKind
  /** Guide scope of the layer; absent for repository files, policies and notes. */
  scope?: GuideScopeKey
  /** `REVIEW.md`, `Team games`, `Family Widgets`, `All repositories`, `Commit policy`, … */
  source: string
  /** The text as the agent gets it, cut when `cut` is set. */
  text: string
  /** Characters of `text`; 0 when the budget left nothing for the layer. */
  chars: number
  /** Characters the layer would take whole. */
  fullChars: number
  /** The budget cut the layer short or left it out. */
  cut: boolean
  /** For `generated`: the version shown, linking to `GET /api/guide/generated/history`. */
  version?: number
  /** For `generated`: proposed text nobody accepted yet. */
  proposed?: boolean
}

/** One section of the Guide chain with its layers. */
export interface GuideChainSection {
  section: GuideSectionName
  /**
   * Layers in exactly the order the agent reads them: repository files, repository rules,
   * family, groups (several, in config order), all repositories, learnings, policies, generated
   * text, notes. Empty sources are left out; numbering has no gaps.
   */
  layers: GuideChainLayer[]
}

/**
 * `GET /api/guide/chain?repo=&section=` — the layered Guide a task of the repository gets, per
 * section (only `section` when given), with the shared budget. Needs `knowledge:read` on the
 * repository. The MCP knowledge tools return the same layers in the same order.
 */
export interface GuideChainView {
  repo: string
  sections: GuideChainSection[]
  /** Characters used against the caps: `total` 12000, `human` 8000, `generated` 4000. */
  budget: GuideCaps & { used: number; humanUsed: number; generatedUsed: number }
  /** Problems a person should see, e.g. repository rules too long to fit. */
  warnings: string[]
}

/** A rules file of the repository itself, as read at its default branch head. */
export interface GuideRepoFileView {
  /** `REVIEW.md`, `AGENTS.md`, `.github/copilot-instructions.md`, … */
  path: string
  /** Blob sha; unchanged sha means unchanged text, so the server caches by it. */
  sha: string
  chars: number
  text: string
}

/**
 * `GET /api/guide/repo-files?repo=` — the rules files of the repository the Guide chain reads as
 * its `repo-file` layer, in that order. Needs `knowledge:read` on the repository.
 */
export interface GuideRepoFilesView {
  repo: string
  /** The default branch head the files were read at, when the forge reports it. */
  sha?: string
  files: GuideRepoFileView[]
}

/** One stored generator run of a section. */
export interface GuideGeneratedVersionView extends GuideGenerated {
  /** A person rejected this text (by its `inputHash`). */
  rejected: boolean
  /** Where the section holds this version now: accepted (`generated`), waiting (`proposal`) or neither. */
  current?: 'generated' | 'proposal'
}

/**
 * `GET /api/guide/generated/history?scope=&section=` — every text the generator stored for the
 * section, newest version first, for Compare. Needs `knowledge:read` on the scope.
 */
export interface GuideGeneratedHistory {
  scope: GuideScopeKey
  section: GuideSectionName
  versions: GuideGeneratedVersionView[]
  /** Names and avatars of the users who accepted versions. */
  people: Record<string, PersonView>
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
 * `POST /api/guide/section/reject`: rejects the generated text waiting for a person in one section.
 * The rejected `inputHash` is remembered for that section: the stored version is kept but hidden
 * from the Guide views and the Inbox, and the generator does not propose text from the same inputs again; changed inputs propose anew. Needs
 * `knowledge:write` on the scope; 409 unless `inputHash` is still the waiting text. Audited as
 * `guide.reject`. Answers the section.
 */
export interface GuideSectionRejectInput {
  scope: GuideScopeKey
  section: GuideSectionName
  inputHash: string
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
  budget: GuideCaps & {
    used: number
    humanUsed: number
    generatedUsed: number
    notesUsed: number
  }
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

/**
 * How a learning candidate came about: one review reply (`review-reply`), a direct proposal of an
 * MCP client without replies (`mcp`), or several discussions, or a proposal plus replies,
 * folded into one rule (`merged`).
 */
export type LearningSourceKind = 'review-reply' | 'mcp' | 'merged'

export interface LearningCandidateView extends LearningCandidate {
  canDecide: boolean
  /** Scope keys of the repository the caller may edit: repository, family, groups, `all`. */
  scopes: GuideScopeKey[]
  sourceKind: LearningSourceKind
  /**
   * 1–5, from the sources alone so the same candidate always scores the same: 1, plus 1 each for
   * at least 2 distinct discussions, at least 2 distinct authors, at least 2 distinct
   * repositories, and at least 3 distinct authors; capped at 5. Authors are the reply authors
   * and the proposer of a direct proposal.
   */
  confidence: number
}

/**
 * `POST /api/learnings/accept` — accepts several candidates at once, each into `scope` (default:
 * the scope its `suggestedScope` points at), with the same rights as accepting one. Each accepted
 * candidate gets its own audit event; one failing never stops the rest.
 */
export interface AcceptLearningsInput {
  ids: string[]
  scope?: GuideScopeKey
}

/** What `POST /api/learnings/accept` did, per candidate, in the order given. */
export interface AcceptLearningsResult {
  /** Ids of the candidates now accepted. */
  accepted: string[]
  /** Candidates left as they were, with why (unknown, no rights, scope not allowed, …). */
  failed: { id: string; error: string }[]
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
  formats: {
    format: string
    width: number
    bytes: number
    savingsPercent: number
  }[]
  bestFormat?: string
  bestSavingsPercent: number
}

/** Result of `POST /api/media/variants`. */
export interface MediaVariantsResult {
  original: {
    bytes: number
    width: number
    height: number
    format: string
    sha256: string
  }
  variants: MediaVariantView[]
  /** For SVG originals: the optimized file, stored as an artifact. */
  svg?: {
    id: string
    before: number
    after: number
    breakdown: Record<string, number>
  }
  /** Markup per framework (`html`, `react`, ...). */
  snippets: Record<string, string>
  savings: MediaSavings
  /**
   * Whether each suggested `variants[].path` already exists at the requested ref; every variant
   * path has an entry.
   */
  exists: Record<string, boolean>
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
    range: {
      start: { line: number; column: number }
      end: { line: number; column: number }
    }
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
  /**
   * Names of the people behind interactive runs (actor id → person), only for callers holding
   * `users:read` in some grant; actors that are not users have no entry.
   */
  people?: Record<string, PersonView>
  /** Pass as `before` for the next page; absent on the last one. */
  next?: Timestamp
}

/** A budget week: Monday 00:00 to the next Monday 00:00 in the instance time zone. */
export interface AiBudgetWeek {
  from: Timestamp
  to: Timestamp
  /** Monday of the week, `YYYY-MM-DD`. */
  key: string
}

/**
 * An `llm.budget` setting, or the implicit default budget, how much of it this week used and
 * where the week is heading.
 */
export interface AiBudgetStatus {
  /** Setting entry id, or `default` for the budget that applies when no global one is set. */
  id: string
  scope: Scope
  action: 'warn' | 'block'
  weeklyUsd: number
  /** Part of `weeklyUsd` only work a person started may spend. */
  reserveUsd: number
  /** Share of `weeklyUsd`, in percent, at which the budget shows as close to its limit. */
  warnPercent: number
  spentUsd: number
  /** Part of `spentUsd` automatic work spent (runs nobody started interactively). */
  automaticUsd: number
  /** `spentUsd / weeklyUsd * 100`. */
  percent: number
  /** Expected spend in the budget's scope by the end of the week, see `AiSpendForecast`. */
  forecastUsd: number
  /**
   * When spend is expected to reach `weeklyUsd - reserveUsd` this week at the forecast pace;
   * absent when it is not expected to, or `spentUsd` already reached it (automatic work stopped).
   */
  automaticStopsAt?: Timestamp
  week: AiBudgetWeek
}

/**
 * Where this budget week's spend is heading: what it spent so far plus, for the rest of the week,
 * the mean spend of the same remaining span over the last 4 full weeks. Weeks before the first
 * recorded usage are not counted; with no full week yet the week's pace so far is extended to its
 * end. A forecast is never below what the week already spent.
 */
export interface AiSpendForecast {
  week: AiBudgetWeek
  /** Spend so far this week. */
  spentUsd: number
  /** Part of `spentUsd` automatic work spent. */
  automaticUsd: number
  /** Expected spend by the end of the week. */
  forecastUsd: number
  /** Expected automatic spend by the end of the week. */
  automaticForecastUsd: number
  /** Mean automatic spend of a full week over the weeks the forecast averages. */
  automaticWeeklyMeanUsd: number
  /** Full past weeks the forecast averages, 0 to 4; 0 when it extends this week's pace instead. */
  weeks: number
  /**
   * The rest of the week by day, today first, on `GET /api/ai/overview`: `usd` sums to
   * `forecastUsd - spentUsd`, `automaticUsd` to `automaticForecastUsd - automaticUsd`.
   */
  days?: AiForecastDay[]
}

/** Expected spend of one remaining day of the budget week. */
export interface AiForecastDay {
  /** Local date in the instance time zone, `YYYY-MM-DD`. */
  day: string
  /** Expected spend of what is left of that day. */
  usd: number
  /** Part of `usd` expected from automatic work. */
  automaticUsd: number
}

/**
 * Spend caps fixed in code, outside the weekly budgets: what one write task and one chat reply may
 * spend. Read-only; budgets narrow spend further.
 */
export interface AiSpendCaps {
  /** Cap of a write task that names none, in USD. */
  writeTaskUsd: number
  /** Highest cap a write task may ask for, in USD. */
  writeTaskMaxUsd: number
  /** Cap of one chat reply, in USD. */
  chatReplyUsd: number
  /**
   * Mean cost of a chat reply that ran in the overview's current period, over what the caller may
   * read (narrowing filters left out); absent without replies.
   */
  chatReplyAvgUsd?: number
}

/** The spans `GET /api/ai/overview` reports: this budget week, this UTC month, the last 30 days. */
export type AiUsagePeriodKind = 'week' | 'month' | '30d'

/** Totals of one span of time. */
export interface AiUsagePeriod {
  /** `YYYY-MM-DD` (Monday) for a week, `YYYY-MM` for a month, `30d:YYYY-MM-DD` (last day) for 30 days. */
  key: string
  from: Timestamp
  to: Timestamp
  totals: AiUsageTotals
  /** Part of `totals.costUsd` automatic work spent. */
  automaticUsd: number
}

/**
 * `GET /api/ai/overview?period=week|month|30d&groups=&feature=&origin=&model=&taskKind=`: one
 * period at a glance, limited to what the caller may see; `groups` (comma list of config groups)
 * narrows it further and never widens it. `feature` (a feature's task kinds), `origin`, `model` and
 * `taskKind` narrow the totals, top lists and forecast as well; `budgets` (and so
 * `automaticStopsAt`) and `caps` always show the real, unnarrowed figures. The default period is
 * `week`.
 */
export interface AiUsageOverview {
  period: AiUsagePeriodKind
  /** From the start of the period to now. */
  current: AiUsagePeriod
  /**
   * The same elapsed span of the previous period: for a week Monday 00:00 to the same weekday and
   * time last week, for a month the same days of the previous month, for 30 days the 30 days before.
   */
  comparison: AiUsagePeriod
  /** The current period, most expensive first, at most 5 each. */
  topRepos: AiUsageBucket[]
  topModels: AiUsageBucket[]
  topTaskKinds: AiUsageBucket[]
  topAnalyzers: AiUsageBucket[]
  /** Budgets whose scope the caller may read; the default one only for readers of everything. */
  budgets: AiBudgetStatus[]
  /** Cache read tokens over all input tokens (fresh, cache read and cache write) of `current`; 0 without input. */
  cacheHitRatio: number
  /** Failed runs over runs that were not denied, of `current`; 0 without runs. */
  errorRate: number
  /**
   * `automaticStopsAt` of the broadest budget among `budgets` (the one covering everything the
   * caller may read, as `HomeSpend` measures); absent when automatic work is not expected to stop.
   */
  automaticStopsAt?: Timestamp
  /** This budget week's forecast over everything the overview covers, whatever `period` is. */
  forecast: AiSpendForecast
  caps: AiSpendCaps
}

/**
 * `GET /api/ai/week?week=YYYY-MM-DD&groups=`: one budget week (default: the current one) split by
 * task kind, analyzer and provider, limited to what the caller may see. Each list is most expensive
 * first; runs without an analyzer (chat, other work people start) share the bucket with an empty
 * `analyzer` key.
 */
export interface AiWeekBreakdown {
  week: AiBudgetWeek
  totals: AiUsageTotals
  byTaskKind: AiUsageBucket[]
  byAnalyzer: AiUsageBucket[]
  byProvider: AiUsageBucket[]
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
 * Outcome of checking whether the forge's token can read a repository before it is added. `ok`:
 * readable and not archived. `not-found`: the path does not exist or the token's account is not a
 * member (GitLab answers 404 for both). `unauthorized`: the token is invalid or expired.
 * `forbidden`: the token lacks a scope. `archived`: Holtkeeper skips archived repositories.
 * `error`: the forge could not be asked.
 */
export type RepoAccessStatus =
  | 'ok'
  | 'not-found'
  | 'unauthorized'
  | 'forbidden'
  | 'archived'
  | 'error'

/** `POST /api/forges/:id/repositories/access`: 1 to 50 paths, e.g. `team/app`; more answer 400. */
export interface RepoAccessBatchInput {
  paths: string[]
}

/** One checked path of a batch; `message` explains a status other than `ok`. */
export interface RepoAccessResult {
  /** The path as sent, trimmed. */
  path: string
  status: RepoAccessStatus
  message?: string
  repository?: { path: string; name: string; webUrl: string }
}

/**
 * Result of `POST /api/forges/:id/repositories/access` (global `settings:write`): one result per
 * distinct path in the order sent (duplicates and blank paths dropped), and the forge token's
 * account once for all of them when the forge tells it: the one to invite.
 */
export interface RepoAccessBatch {
  account?: { username: string; name: string }
  results: RepoAccessResult[]
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

/**
 * `GET /api/schedules/runs?limit=10`: recent runs of every schedule, newest first, and `next`, its
 * next five run times in order as `nextRuns` computes them (time zone, windows and jitter applied;
 * empty for a disabled schedule).
 */
export interface ScheduleRunList {
  schedules: { id: string; runs: ScheduleRun[]; next: Timestamp[] }[]
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
    /** Who issued the current URL: a user's name, else the principal id. */
    createdBy?: { id: string; name: string }
    registered?: RegisteredWebhook[]
    /** Deliveries of the last 24 hours and how many of them were rejected. */
    deliveries24h: { total: number; failed: number }
    /** The newest deliveries first, at most 50; older ones are dropped. */
    deliveries: WebhookDeliveryView[]
  }
  /** Whether the forge can register the webhook itself. */
  canRegister: boolean
  /**
   * Holtkeeper's own hooks that reach the repository (its own and the forge-wide group or project
   * hook), as the last health check found them; absent before the first check.
   */
  webhookHealth?: WebhookHealthView[]
}

/**
 * What the last health check found out about one of Holtkeeper's own hooks on the forge. Hooks
 * the forge disabled after failed deliveries are re-enabled every 15 minutes; a failed attempt
 * waits until `retryAt`, doubling from 15 minutes up to a day; a rate-limited one retries a minute
 * later. A disabled hook without `retryAt` is one the forge cannot re-enable. `unknown`: the forge
 * could not be asked (`lastError` says why).
 */
export interface WebhookHealthView {
  /** `forge` for the forge-wide hook, `repo` for a repository's own. */
  owner: 'forge' | 'repo'
  scope: 'group' | 'project'
  /** Group or project path the hook sits on. */
  target: string
  hookId: string
  state: 'enabled' | 'temporarily_disabled' | 'disabled' | 'missing' | 'unknown'
  /** When the forge would deliver to a temporarily disabled hook again on its own. */
  disabledUntil?: Timestamp
  checkedAt: Timestamp
  /** Last time Holtkeeper turned the hook back on. */
  reenabledAt?: Timestamp
  lastError?: string
  /** Failed re-enable attempts in a row. */
  failures?: number
  retryAt?: Timestamp
}

/** Counts of a forge's hooks from the last health check. */
export interface WebhookHealthSummary {
  checkedAt: Timestamp
  total: number
  /** Still disabled after the check, temporarily or for good. */
  disabled: number
  missing: number
  /** The forge could not be asked about them. */
  unknown: number
  /** Re-enabled within the last 24 hours. */
  reenabled24h: number
}

/**
 * `POST /api/integrations/forges/:id/webhooks/reenable`: checks the forge's hooks now and
 * re-enables disabled ones at once, ignoring the retry wait.
 */
export interface WebhookReenableResult {
  checked: number
  reenabled: number
  failed: number
  hooks: WebhookHealthView[]
}

/**
 * One delivery to a repository's webhook URL. `error` means it was rejected (unknown token, bad
 * signature, unreadable body) and nothing ran; otherwise it queued `enqueued` jobs or says why it
 * was `ignored`.
 */
export interface WebhookDeliveryView {
  at: Timestamp
  /** Forge event header, e.g. `Push Hook`. */
  event: string
  /** What the event was about, e.g. `push to main, 3 commits`, when the payload says. */
  summary?: string
  enqueued: number
  ignored?: string
  error?: string
  durationMs: number
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
  /** Members from the last successful listing; kept when a later one fails. */
  repos: RepoRef[]
  /**
   * Every repository an include pattern matched in that listing, before exclude patterns applied,
   * so a page can show what each exclude pattern keeps out and preview unsaved patterns. Only for
   * callers with global `settings:write`: excludes often keep other teams' repositories out.
   */
  matched?: RepoRef[]
  listedAt?: Timestamp
  /** When the next scheduled listing is due; absent while listing is off. */
  nextAt?: Timestamp
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
  /** How the package name matched `q`; set only when the list was filtered by `q`. */
  match?: PublicApiMatch
}

/**
 * How a name matched a query, best first: the whole name, its start, part of it, or only words of
 * its doc comment (description for packages). Matching ignores case.
 */
export type PublicApiMatch = 'exact' | 'prefix' | 'part' | 'doc'

/** A facet value and how many listed items carry it. */
export interface PublicApiFacetCount {
  value: string
  count: number
}

/**
 * Counts for narrowing a public API list, over the items before the facet filters apply. Each
 * list is most first, then by value.
 */
export interface PublicApiFacets {
  /** Symbol kinds (`function`, `interface`, ...). */
  kinds: PublicApiFacetCount[]
  /** Package names. */
  packages: PublicApiFacetCount[]
  /** Repositories as `forge:path`. */
  repos: PublicApiFacetCount[]
  /** Entry point subpaths; set by search only. */
  subpaths?: PublicApiFacetCount[]
  /** `PublicApiMatch` values; set by search only. */
  matches?: PublicApiFacetCount[]
}

/** `GET /api/api-surface/packages?q=`. */
export interface PublicApiPackageList {
  packages: PublicApiPackageSummary[]
  facets: PublicApiFacets
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
  /** Release the record describes; absent for a default branch run. */
  ref?: string
  match: PublicApiMatch
  /** The symbol carries `@deprecated`. */
  deprecated: boolean
  /** Its repository no longer has the package. */
  removed: boolean
  symbol: ApiSymbol
}

/** `GET /api/api-surface/search?q=&package=&kind=&limit=`; hits best match first. */
export interface PublicApiSearchResult {
  hits: PublicApiSymbolHit[]
  /** Matches beyond `limit`. */
  more: number
  facets: PublicApiFacets
}

/** One recorded version where an exported symbol appeared, changed, was deprecated or was dropped. */
export interface PublicApiSymbolChange {
  version: string
  ref?: string
  analyzedAt: Timestamp
  change: 'added' | 'changed' | 'deprecated' | 'removed'
  /** Declarations before and after; absent for `added` (no before) and `removed` (no after). */
  before?: string
  after?: string
}

/**
 * `GET /api/api-surface/symbol?package=&name=&subpath=&version=&repo=` — one exported symbol in
 * full: declaration, doc comment, where it is declared, and the recorded versions where it changed.
 */
export interface PublicApiSymbol {
  package: string
  version?: string
  repo: RepoRef
  /** Release the record describes; absent for a default branch run. */
  ref?: string
  analysisId: string
  analyzedAt: Timestamp
  subpath: string
  importPath: string
  /** Declaration (`signature`), doc comment (`doc`), `deprecated` text and source location. */
  symbol: ApiSymbol
  /** Other subpaths of the same version exporting the same name. */
  alsoIn: string[]
  /** Set when the repository no longer has the package. */
  removed?: PublicApiPackageRemoval
  history: {
    /** Newest first; at most a fixed number of entries. */
    changes: PublicApiSymbolChange[]
    /** Recorded versions compared. */
    versions: number
    /** Older versions were left out by the cap. */
    capped: boolean
  }
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
  /** Per principal, most calls first; only for callers with `users:read`, else just the caller. */
  people: McpPersonUsage[]
  /** The caller's own calls; zero when it made none. */
  me: McpPersonUsage
  /** Calls per token of the caller's own tokens, most first; other people's tokens never show. */
  tokens: McpTokenUsage[]
  /** Newest first; other people's calls only for callers with `users:read`. */
  recent: McpCallView[]
  /** URL to configure in MCP clients. */
  endpoint: string
}

/** One person's MCP calls over the days of an `McpUsageOverview`. */
export interface McpPersonUsage {
  id: string
  name: string
  calls: number
  errors: number
  /** Newest call; absent when the person made none in the window. */
  lastAt?: Timestamp
  /** The 10 most used tools, most first. */
  tools: { tool: string; calls: number }[]
  /** The 10 packages the person's calls asked about most, most first. */
  packages: { name: string; calls: number }[]
  /** The 10 MCP clients the person called from most, most first. */
  clients: { client: string; calls: number }[]
  /** Calls per day, aligned with `McpUsageOverview.days`. */
  daily: number[]
  /** Failed calls per day, aligned with `McpUsageOverview.days`. */
  dailyErrors: number[]
  /** The person's home groups (picked, else from their grants); empty when unknown. */
  teams: GroupMatch[]
  /** MCP tokens the person holds that have not expired. */
  activeTokens: number
}

/** Calls one MCP token made over the days of an `McpUsageOverview`. */
export interface McpTokenUsage {
  /** `McpTokenView.id`. */
  id: string
  calls: number
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
  failures: {
    library: string
    version?: string
    source: string
    message: string
  }[]
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
  days: {
    day: string
    total: GitHubRequestCounts
    byToken: Record<string, number>
  }[]
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
  | 'allowlist-expiring'
  | 'release'
  | 'learnings'
  | 'knowledge'
  | 'stale-analyses'
  | 'not-analysed'

/** How urgent a Needs-attention item is; the list is sorted by it, most urgent first. */
export type HomeSeverity = 'critical' | 'high' | 'medium' | 'low'

/**
 * The one action a Needs-attention row offers. `retry` re-queues `analyzer` on every repository of
 * the item (`POST /api/jobs`), offered only when the caller holds `analyses:run` on each of them.
 * `review` and `renew` open the matching Inbox item; `open` goes
 * to the page that shows the cause. `href` is set for every type but `retry`.
 */
export type HomeAttentionAction =
  | { type: 'retry'; label: string; analyzer: string }
  | { type: 'review' | 'renew' | 'open'; label: string; href: string }

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
  /**
   * Web UI path to act on it, query string included. Releases the caller may decide, learnings,
   * knowledge proposals and allowlist entries open their Inbox item (`/inbox?item=<InboxItem.id>&kind=`).
   */
  href: string
  action: HomeAttentionAction
  /** The caller snoozed `id` and the snooze has not run out; snoozed items stay in the list. */
  snoozed?: boolean
}

/** Areas of What changed, each a group of audit log actions. */
export type HomeChangeKind =
  | 'release'
  | 'deploy'
  | 'settings'
  | 'knowledge'
  | 'guide'
  | 'repo'
  | 'credentials'
  | 'access'
  | 'task'

/**
 * One audit log event of What changed. `text` is one deterministic sentence without the actor's
 * name, built only from whitelisted fields (the action, the repository, release versions, tags and
 * environments, setting keys, advisory ids), never from free text or changed values.
 */
export interface HomeChange {
  /** The audit event id. */
  id: string
  kind: HomeChangeKind
  /** e.g. `Cut version 1.4.0 of acme/widget-kit`. */
  text: string
  /** Web UI path of the page that shows what changed. */
  href: string
  at: Timestamp
  /** Principal id of who acted, resolved in `HomeView.people`. */
  actor: string
  /** Absent for instance-level events. */
  repo?: HomeRepoRef
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
  /** Share of `weeklyUsd`, in percent, at which the bar shows as close to the limit. */
  warnPercent: number
  /** Expected spend by the end of the week, as `AiBudgetStatus.forecastUsd`. */
  forecastUsd: number
  /** As `AiBudgetStatus.automaticStopsAt`. */
  automaticStopsAt?: string
  action: 'block' | 'warn'
  /** Spend by task kind (`review`, `chat`, ...) over the caller's readable usage, largest first. */
  byFeature: { feature: string; costUsd: number; runs: number }[]
}

/**
 * `GET /api/home`: the Home page in one read, built from stored data only (no forge calls) and
 * filtered by the caller's permissions: job items and analyses need `analyses:read`, vulnerability
 * items `audits:read`, release items `releases:read`, learnings and knowledge proposals
 * `knowledge:write` where they would be decided, changes what History shows the caller, spend
 * `ai:read`, allowlist entries `settings:write` on their scope. Scoping to the viewer's teams is
 * left to the client: every row names its repositories and their groups. Repository health lives
 * in `/api/repos`, not here.
 */
export interface HomeView {
  generatedAt: string
  attention: HomeAttentionItem[]
  /** History of the last `changesDays` days, newest first. */
  changes: HomeChange[]
  changesDays: number
  /** Absent without `ai:read`. */
  spend?: HomeSpend
  /** Names and avatars of the users among `changes` actors. */
  people: Record<string, PersonView>
}

/** What an Inbox item asks a person to decide. */
export type InboxKind = 'task' | 'note' | 'learning' | 'guide' | 'release' | 'allowlist' | 'budget'

/** What every Inbox item carries, whatever its kind. */
interface InboxItemBase {
  /** `<kind>:<source id>`, stable while the decision waits; also the id a snooze names. */
  id: string
  kind: InboxKind
  title: string
  /** Where the decision applies, as people read it: `acme/widget-kit`, `Team Web`, `All repositories`. */
  scope: string
  /** Repositories it concerns with their config groups; empty for items above any repository. */
  repos: HomeRepoRef[]
  detail?: string
  /** Web UI path that opens the item, built with `webPaths`. */
  href: string
  /** When the decision started waiting. */
  createdAt: Timestamp
  /** Principal id of whoever proposed it, resolved in `InboxFeed.people`; absent for the system. */
  proposedBy?: string
  /** The caller snoozed `id` and the snooze has not run out. */
  snoozed: boolean
  /** When the decision lapses on its own (an allowlist entry expiring); absent when it never does. */
  dueAt?: Timestamp
}

/** A proposed task group waiting for approval; nothing runs before a person approves it. */
export interface InboxTaskItem extends InboxItemBase {
  kind: 'task'
  groupId: string
  taskKind: AgentTaskKind
}

/** A proposed knowledge note waiting for acceptance. */
export interface InboxNoteItem extends InboxItemBase {
  kind: 'note'
  entryId: string
  /** The entry version a decision applies to. */
  version: number
}

/** A learning candidate waiting for acceptance; accepting without a scope uses `suggestedScope`. */
export interface InboxLearningItem extends InboxItemBase {
  kind: 'learning'
  learningId: string
  section: GuideSectionName
  suggestedScope: LearningScopeKind
}

/** Generated Guide text waiting for a person to accept or reject it. */
export interface InboxGuideItem extends InboxItemBase {
  kind: 'guide'
  guideScope: GuideScopeKey
  section: GuideSectionName
  /** Pass to accept and to `GuideSectionRejectInput`, so a decision names the text it was made on. */
  inputHash: string
  generatedAt: Timestamp
}

/** A repository's release waiting for a step or for acceptance of the target branch head. */
export interface InboxReleaseItem extends InboxItemBase {
  kind: 'release'
  /** `forge:path` */
  repo: string
  stage: ReleaseStage
  /** Suggested next version. */
  next?: string
  /** The commit a dismiss names, as `ReleaseCard.head`. */
  head: string
  /** As `ReleaseCard.can`: Accept is offered only when `accept` is true. */
  can: { accept: boolean; run: boolean }
}

/** An `audit.allowlist` entry that expires within 7 days or has expired. */
export interface InboxAllowlistItem extends InboxItemBase {
  kind: 'allowlist'
  /** The `audit.allowlist` setting entry holding it. */
  settingId: string
  settingScope: Scope
  entry: AllowlistEntry
  /** Last day the entry applies, `YYYY-MM-DD`. */
  expires: string
  expired: boolean
}

/**
 * This week's AI spend passed the `llm.budget` `warnPercent`. At most one per budget and week;
 * nothing to approve, dismissing it only acknowledges the warning.
 */
export interface InboxBudgetItem extends InboxItemBase {
  kind: 'budget'
  /** Monday of the week, `YYYY-MM-DD`. */
  week: string
  spentUsd: number
  weeklyUsd: number
  warnPercent: number
  /** The `llm.budget` setting entry that applies; absent when the defaults do. */
  settingId?: string
}

/** One decision waiting in the Inbox. */
export type InboxItem =
  | InboxTaskItem
  | InboxNoteItem
  | InboxLearningItem
  | InboxGuideItem
  | InboxReleaseItem
  | InboxAllowlistItem
  | InboxBudgetItem

/**
 * `GET /api/inbox`: every decision the caller may make, oldest first in each section. `mine` holds
 * what the caller may decide inside their home groups and `teams` what they may decide elsewhere;
 * a caller without home groups gets everything in `mine`. An item sits in one section only.
 * Snoozed items are included with `snoozed: true`. Decisions are not available through MCP.
 */
export interface InboxFeed {
  mine: InboxItem[]
  teams: InboxItem[]
  /** Names and avatars of the users among `proposedBy`. */
  people: Record<string, PersonView>
}

/**
 * `GET /api/inbox/count`: the sizes of `InboxFeed` sections without snoozed items, read from stored
 * data only (no forge calls); answers with an ETag. `total` is `mine + teams`.
 */
export interface InboxCount {
  mine: number
  teams: number
  total: number
}

/**
 * `POST /api/audits/allowlist/renew`: moves the expiry of one entry of an `audit.allowlist` setting
 * entry. The entry is found by `advisory` (its `id`) and `package` (absent matches an entry without
 * one); the setting value is rewritten with the new `expires`, last write wins. Needs
 * `settings:write` on the setting's scope; audited as `allowlist.renew`. Answers the `SettingView`.
 * The renewed entry follows `audit.allowlistPolicy`: an expiry past `maxDays` from today or a blank
 * reason when one is required answers 400.
 */
export interface AllowlistRenewInput {
  settingId: string
  advisory: string
  package?: string
  /** New last day the entry applies, `YYYY-MM-DD`, not in the past. */
  expires: string
  /** Replaces the stored reason. */
  reason?: string
}

/**
 * A personal snooze: the item `id` stays visible but counts as handled until `until`. Ids are
 * `HomeAttentionItem.id` or `InboxItem.id`; a job failure is `job-failures:<analyzer>:<signature>`,
 * or `job-failures:<analyzer>:<repo>` when the failure has no signature.
 */
export interface Snooze {
  id: string
  until: Timestamp
}

/**
 * `POST /api/me/snoozes`: snoozes `id` for the caller until `until` (in the future), replacing an
 * earlier snooze of the same id. `DELETE /api/me/snoozes?id=` ends one. Snoozes are not audited.
 */
export type SnoozeInput = Snooze

/** `GET /api/me/snoozes`: the caller's snoozes that have not run out, soonest to end first. */
export interface SnoozeList {
  snoozes: Snooze[]
}

/** One repository's part of a task group, as the API shows it. The patch is left out. */
export type AgentTaskView = Omit<AgentTask, 'patch'> & {
  /** The branch the task pushes, the same in every repository of its group. */
  branch: string
  /**
   * CI of the task's open merge request as last read from the forge (`pending` until read);
   * `none` for a task without an open merge request.
   */
  ci: AgentTaskCi
  /**
   * The size of the change for the Diff tab: the merge request's (`merge-request`, read from the
   * forge whenever its head moved) or else the patch the task or its group carries (`patch`).
   * Absent when neither is known.
   */
  diffstat?: AgentTaskDiffstat & { source: 'merge-request' | 'patch' }
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
  /**
   * What the caller may do with it now: `approve` its proposed tasks, `cancel` its active tasks,
   * `retry` its failed or cancelled tasks (`tasks:run` on each of their repositories), `reject` it
   * while it is `proposed` (the proposer, or `tasks:run` on every target).
   */
  can: { approve: boolean; cancel: boolean; retry: boolean; reject: boolean }
}

/**
 * `GET /api/task-groups/needs-approval`: how many task groups the caller sees that wait for
 * approval (a task still `proposed`), for the Tasks tab badge. Proposed tasks never expire.
 */
export interface TaskApprovalCount {
  count: number
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
 * doing, read from write task jobs. `spentUsd` needs `ai:read` or
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
    /** How many workers run write tasks now. */
    busyWorkers: number
    /**
     * Live workers in the worker registry, of every pool: the registry does not record pools, so
     * this is an upper bound on write workers. Absent when the server has no KV store.
     */
    totalWorkers?: number
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

// Request limits usage (Settings › Integrations › Request limits)

/** The effective limits of one limiter key; omitted fields are unlimited. */
export interface LimitUsagePolicy {
  maxConcurrent?: number
  requestsPerMinute?: number
  /** Request units that may be spent at once; defaults to `requestsPerMinute`. */
  burst?: number
  tokensPerMinute?: number
  tokensPerDay?: number
  costPerDayUsd?: number
}

/** Live usage of one credential's request limits. */
export interface LimitUsageRow {
  /** The limiter key: a credential id, `forge:<id>` for a forge without one, or a configured key. */
  key: string
  credentialId?: string
  /** The credential's name, `Forge <id>`, or the configured key when nothing matches it. */
  name: string
  kind?: string
  /** A `limits.credentials` entry names a key no credential or forge has. */
  missing?: boolean
  policy: LimitUsagePolicy
  /** `configured` when a `limits.credentials` entry sets any field, else the kind defaults. */
  source: 'configured' | 'default'
  /** Request units granted over the last 60 minutes. */
  requestsLastHour: number
  /** AI tokens of finished work over the last 60 minutes. */
  tokensLastHour: number
  /** Leases held now. */
  inFlight: number
  /** ISO 8601; present while a cool-down after a rate-limit answer is active. */
  coolDownUntil?: string
  /** ISO 8601 time of the last rate-limit answer. */
  last429At?: string
  /** AI tokens and USD counted for the current UTC day. */
  dayTokens: number
  dayCostUsd: number
}

/** `GET /api/limits/usage`. */
export interface LimitUsageList {
  rows: LimitUsageRow[]
  /** True when the counters are shared by every server process; false when they cover this one only. */
  shared: boolean
  /** ISO 8601 time the counters were read; the answer may be cached for a few seconds. */
  readAt: string
}
