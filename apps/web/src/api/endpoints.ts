import type {
  AssetsOverview,
  AssetsQuery,
  BranchesOverview,
  BundlesOverview,
  CiFleetJobSort,
  CiFleetJobsView,
  CiJobsView,
  ReviewDetail,
  ReviewList,
  ReviewQuery,
  AcceptGuideSectionInput,
  AgentTaskGroupDetail,
  AgentTaskGroupInput,
  AgentTaskGroupList,
  AgentTaskGroupView,
  TaskApprovalCount,
  WriteTasksStatus,
  AcceptLearningInput,
  AcceptLearningsInput,
  AcceptLearningsResult,
  AgentTranscriptView,
  EditLearningInput,
  Family,
  FamilyInput,
  FamilyList,
  FamilySuggestionDismissInput,
  FamilySuggestionList,
  GuideChainView,
  GuideGeneratedHistory,
  GuidePreview,
  GuideRepoFilesView,
  GuideScopeKey,
  GuideScopeView,
  GuideSection,
  GuideSectionDetail,
  GuideSectionName,
  GuideTask,
  LearningCandidate,
  LearningList,
  LearningStatus,
  PutGuideSectionInput,
  ReactionTotalsList,
  RegenerateGuideInput,
  AnalysisBackfillInput,
  AnalysisBackfillStarted,
  ChatMessageList,
  ChatPeopleView,
  ChatPostInput,
  ChatPostResult,
  ChatReadInput,
  ChatThreadInput,
  ChatThreadContextView,
  ChatThreadList,
  ChatThreadPatchInput,
  ChatThreadView,
  ChatUnreadView,
  SlackConnectInput,
  SlackEmojiInput,
  SlackSettingsView,
  AccountChallenge,
  AiRunList,
  AiUsageBuckets,
  AiUsageOverview,
  AiUsagePeriodKind,
  AiWeekBreakdown,
  AuditVerifyResponse,
  ClearStorageInput,
  ClearStorageResult,
  DatabaseQueries,
  DatabaseQuerySort,
  DatabaseSessionsView,
  DatabaseView,
  DeleteEgressCacheInput,
  DeleteEgressCacheResult,
  EgressCacheView,
  CreateMcpTokenInput,
  CreateMcpTokenResult,
  McpTokenList,
  McpUsageOverview,
  PublicApiDiff,
  PublicApiPackageDetail,
  PublicApiPackageList,
  PublicApiSearchResult,
  PublicApiMatch,
  PublicApiSymbol,
  FindingsResponse,
  LicensesOverview,
  DependencyApi,
  PackageUsageView,
  UsageSitesView,
  CreateJobInput,
  ExternalAccountList,
  ExternalAccountView,
  ForgeWebhookInput,
  ForgeWebhookResult,
  Job,
  JobAnalyzerList,
  JobCountView,
  JobFailureList,
  JobList,
  JobLog,
  JobRunList,
  JobStats,
  JobTargetList,
  JobWhy,
  LinkAccountInput,
  MediaApplyInput,
  MediaApplyResult,
  MediaVariantsInput,
  MediaVariantsResult,
  RepoOverview,
  ReleaseAcceptInput,
  ReleaseOverview,
  ReleaseDeployInput,
  ReleaseDetectView,
  ReleaseEditsInput,
  ReleaseRepoView,
  ReleaseStepInput,
  ReleaseTimelineView,
  ReleaseVersionDetailView,
  ReleaseStepResult,
  ReleaseSummaryInput,
  DeployState,
  RepoAvatarInfo,
  FreshnessOverview,
  ScheduleRunList,
  ScheduleRunStarted,
  StorageOverview,
  AiCatalogProviderList,
  AnalysisDetail,
  BundleTargetReportView,
  BundleTargetsView,
  AnalysisList,
  ApplyChangesInput,
  ApplyChangesResult,
  ConfigEntryList,
  ConfigEntryView,
  CreateKnowledgeInput,
  ForgeAccountView,
  ForgeRepositoryList,
  ForgeSshKeyInput,
  ForgeSshKeyResult,
  GitHubTokenUsage,
  GroupDocumentData,
  GroupListingView,
  HistoryList,
  HomeView,
  HistoryScope,
  AllowlistRenewInput,
  GuideSectionRejectInput,
  InboxCount,
  InboxFeed,
  KnowledgeCounts,
  KnowledgeDetail,
  ReleaseDismissInput,
  SnoozeInput,
  SnoozeList,
  PutConfigInput,
  AuditRunDetail,
  AuditRunList,
  CreateCredentialInput,
  CredentialList,
  CredentialTestInput,
  CredentialTestResult,
  CredentialView,
  CiOverview,
  CiRepoView,
  CoverageOverview,
  RepoAssetsView,
  RepoCoverageView,
  DependencyDetail,
  DependencySearchResult,
  DependencyTable,
  DependencyUpgrade,
  StackOverview,
  InviteUserInput,
  KnowledgeEntry,
  KnowledgeList,
  KnowledgeStatus,
  LibraryIndexStatus,
  LibraryReindexResult,
  LibrarySearchResult,
  LinkInfo,
  LinkResponse,
  MePrincipal,
  MeResponse,
  ProviderModelList,
  PutSettingInput,
  RepoAccessBatch,
  RepoAccessBatchInput,
  RepoList,
  RepoPollResult,
  RepoRef,
  RepoUpdatesView,
  RepoWebhookInput,
  ResolvedSettings,
  SetAvatarInput,
  SettingList,
  SettingView,
  UpdateCredentialInput,
  UpdateKnowledgeInput,
  UpdateUserInput,
  UserList,
  UserPreferences,
  UserPreferencesInput,
  UserView,
} from '@holtkeeper/api'
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser'

import type { McpTool } from '../lib/mcp.ts'
import { repoKey } from '../lib/repo.ts'
import type { ScopeFocus } from '../lib/scope.ts'
import { mcpRequest, request, requestBlob, uploadFile, urlOf } from './client.ts'

const id = (value: string) => encodeURIComponent(value)

/** Filters of the job list; `repos` are `forge:path` keys, `repo` wins over them. */
export interface JobQuery {
  status?: string
  repo?: RepoRef
  repos?: readonly string[]
  analyzer?: string
  trigger?: string
  schedule?: string
  signature?: string
  /** Only the jobs that produced this analysis. */
  analysisId?: string
  /** Id prefix, repository, group, analyzer or its label, matched by the server. */
  q?: string
}

/** Config collections of `/api/config/<collection>` and the document type each holds. */
export interface ConfigCollections {
  forges: 'forge'
  groups: 'group'
  schedules: 'schedule'
  triggers: 'trigger'
}

/** Filters of `GET /api/ai/usage` and `GET /api/ai/runs`. */
export interface AiUsageQuery {
  repo?: string
  group?: string
  model?: string
  provider?: string
  taskKind?: string
  /** A feature with a fixed list of task kinds (`FilterableFeature`); narrows to those kinds. */
  feature?: string
  analyzer?: string
  outcome?: string
  /** `interactive` or `automatic`. */
  origin?: string
  actor?: string
  /** Comma list of config groups; narrows what the caller may read. */
  groups?: string
  from?: string
  to?: string
}

/** Query of `GET /api/ai/overview`. */
export interface AiOverviewQuery {
  period?: AiUsagePeriodKind
  /** Comma list of config groups. */
  groups?: string
  /** Narrows everything but budgets and caps, as `AiUsageQuery.feature`. */
  feature?: string
  /** `interactive` or `automatic`. */
  origin?: string
  model?: string
}

/** A job filter as the query string of `GET /api/jobs` and `GET /api/jobs/count`. */
const jobQuery = (filter: JobQuery) => ({
  status: filter.status,
  repo: filter.repo ? repoKey(filter.repo) : undefined,
  repos: filter.repos?.join(','),
  analyzer: filter.analyzer,
  trigger: filter.trigger,
  schedule: filter.schedule,
  signature: filter.signature,
  analysisId: filter.analysisId,
  q: filter.q?.trim() || undefined,
})

/**
 * Filters of `GET /api/history` and the audit export; `repos` is a comma list. `targetType` and
 * `targetId` keep the events about one target, e.g. `schedule` and a schedule's name.
 */
export interface HistoryQuery {
  actor?: string
  action?: string
  repos?: string
  outcome?: string
  from?: string
  targetType?: string
  targetId?: string
}

type Query = Record<string, string | number | undefined>
const toQuery = (value: object): Query =>
  Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string | number] =>
        typeof entry[1] === 'string' || typeof entry[1] === 'number',
    ),
  )

/** Filters of `GET /api/api-surface/search`; facet counts come back for the whole match set. */
export interface PublicApiSearchQuery {
  q: string
  package?: string
  repo?: string
  subpath?: string
  kind?: string
  match?: PublicApiMatch
  limit?: number
}

/** One exported name of `GET /api/api-surface/symbol`; `limit` caps its history entries. */
export interface PublicApiSymbolQuery {
  package: string
  name: string
  subpath?: string
  version?: string
  repo?: string
  limit?: number
}

/** Every server endpoint the UI uses. Nothing outside `src/api/` knows a URL. */
export const api = {
  me: (signal?: AbortSignal) => request<MeResponse>('GET', '/api/me', signal ? { signal } : {}),

  home: () => request<HomeView>('GET', '/api/home'),
  inbox: () => request<InboxFeed>('GET', '/api/inbox'),
  inboxCount: () => request<InboxCount>('GET', '/api/inbox/count'),
  snooze: (input: SnoozeInput) => request<SnoozeList>('POST', '/api/me/snoozes', { body: input }),
  unsnooze: (itemId: string) =>
    request<SnoozeList>('DELETE', '/api/me/snoozes', { query: { id: itemId } }),
  dismissRelease: (input: ReleaseDismissInput) =>
    request<{ ok: true }>('POST', '/api/releases/dismiss', { body: input }),
  rejectGuideSection: (input: GuideSectionRejectInput) =>
    request<GuideSection>('POST', '/api/guide/section/reject', { body: input }),
  renewAllowlist: (input: AllowlistRenewInput) =>
    request<SettingView>('POST', '/api/audits/allowlist/renew', { body: input }),
  repos: () => request<RepoList>('GET', '/api/repos'),
  repoUpdates: (repo: string) =>
    request<RepoUpdatesView>('GET', '/api/repos/updates', { query: { repo } }),
  pollRepo: (repo: string) =>
    request<RepoPollResult>('POST', '/api/repos/updates/poll', { body: { repo } }),
  issueRepoWebhook: (input: RepoWebhookInput) =>
    request<RepoUpdatesView>('POST', '/api/repos/updates/webhook', { body: input }),
  removeRepoWebhook: (repo: string) =>
    request<void>('DELETE', '/api/repos/updates/webhook', { query: { repo } }),
  reenableRepoWebhooks: (repo: string) =>
    request<RepoUpdatesView>('POST', '/api/repos/updates/webhook/reenable', { body: { repo } }),
  groupListing: (group: string) =>
    request<GroupListingView>('GET', `/api/repos/updates/groups/${id(group)}`),
  listGroup: (group: string) =>
    request<GroupListingView>('POST', `/api/repos/updates/groups/${id(group)}/list`),

  auditRuns: (query: { repo?: RepoRef; limit?: number; before?: string }) =>
    request<AuditRunList>('GET', '/api/audit-runs', {
      query: {
        repo: query.repo ? repoKey(query.repo) : undefined,
        limit: query.limit,
        before: query.before,
      },
    }),
  auditRun: (runId: string) => request<AuditRunDetail>('GET', `/api/audit-runs/${id(runId)}`),
  findings: (repo?: RepoRef) =>
    request<FindingsResponse>('GET', '/api/audits/findings', {
      query: { repo: repo ? repoKey(repo) : undefined },
    }),
  licenses: () => request<LicensesOverview>('GET', '/api/licenses'),

  dependencies: () => request<DependencyTable>('GET', '/api/dependencies'),
  dependencySearch: (q: string, limit?: number) =>
    request<DependencySearchResult>('GET', '/api/dependencies/search', {
      query: toQuery({ q, limit }),
    }),
  stack: () => request<StackOverview>('GET', '/api/stack'),
  dependency: (ecosystem: string, name: string) =>
    request<DependencyDetail>('GET', '/api/dependencies/library', { query: { ecosystem, name } }),
  dependencyApi: (ecosystem: string, name: string) =>
    request<DependencyApi>('GET', '/api/dependencies/api', { query: { ecosystem, name } }),
  dependencyUpgrade: (query: { ecosystem: string; name: string; from?: string; to?: string }) =>
    request<DependencyUpgrade>('GET', '/api/dependencies/upgrade', { query }),
  dependencyDocs: (query: {
    q: string
    ecosystem?: string
    name?: string
    version?: string
    limit?: number
  }) => request<LibrarySearchResult>('GET', '/api/dependencies/docs', { query }),
  ciOverview: () => request<CiOverview>('GET', '/api/ci'),
  ciRepo: (repo: RepoRef) =>
    request<CiRepoView>('GET', '/api/ci/repo', { query: { repo: repoKey(repo) } }),
  ciJobs: (repo: RepoRef, limit?: number) =>
    request<CiJobsView>('GET', '/api/ci/jobs', { query: { repo: repoKey(repo), limit } }),
  ciFleetJobs: (sort: CiFleetJobSort, limit?: number) =>
    request<CiFleetJobsView>('GET', '/api/ci/jobs/fleet', { query: { sort, limit } }),
  coverageOverview: () => request<CoverageOverview>('GET', '/api/coverage'),
  repoCoverage: (repo: RepoRef) =>
    request<RepoCoverageView>('GET', '/api/coverage/repo', { query: { repo: repoKey(repo) } }),

  publicApiPackages: (q?: string) =>
    request<PublicApiPackageList>('GET', '/api/api-surface/packages', { query: { q } }),
  publicApiPackage: (query: { name: string; version?: string; repo?: string }) =>
    request<PublicApiPackageDetail>('GET', '/api/api-surface/package', { query: toQuery(query) }),
  publicApiMarkdownUrl: (query: { name: string; version?: string; repo?: string }) =>
    urlOf('/api/api-surface/package.md', toQuery(query)),
  publicApiDiff: (query: { name: string; from?: string; to?: string; repo?: string }) =>
    request<PublicApiDiff>('GET', '/api/api-surface/diff', { query: toQuery(query) }),
  publicApiSearch: (query: PublicApiSearchQuery) =>
    request<PublicApiSearchResult>('GET', '/api/api-surface/search', { query: toQuery(query) }),
  publicApiSymbol: (query: PublicApiSymbolQuery) =>
    request<PublicApiSymbol>('GET', '/api/api-surface/symbol', { query: toQuery(query) }),
  packageUsage: (name: string) =>
    request<PackageUsageView>('GET', '/api/api-surface/usages/package', { query: { name } }),
  usageSites: (query: {
    package: string
    export?: string
    member?: string
    prop?: string
    kind?: string
    repo?: string
    limit?: number
  }) => request<UsageSitesView>('GET', '/api/api-surface/usages/sites', { query: toQuery(query) }),
  publicApiRescan: () => request<{ indexedAt?: string }>('POST', '/api/api-surface/rescan'),
  mcpTokens: () => request<McpTokenList>('GET', '/api/api-surface/mcp/tokens'),
  createMcpToken: (input: CreateMcpTokenInput) =>
    request<CreateMcpTokenResult>('POST', '/api/api-surface/mcp/tokens', { body: input }),
  revokeMcpToken: (tokenId: string) =>
    request<void>('DELETE', `/api/api-surface/mcp/tokens/${id(tokenId)}`),
  mcpUsage: (days: number) =>
    request<McpUsageOverview>('GET', '/api/api-surface/mcp/usage', { query: { days } }),
  mcpTools: () => mcpRequest<{ tools: McpTool[] }>('tools/list').then((result) => result.tools),

  analyses: (query: { repo?: RepoRef; kind?: string; limit?: number; before?: string }) =>
    request<AnalysisList>('GET', '/api/analyses', {
      query: {
        repo: query.repo ? repoKey(query.repo) : undefined,
        kind: query.kind,
        limit: query.limit,
        before: query.before,
      },
    }),
  analysis: (analysisId: string, compare?: string) =>
    request<AnalysisDetail>('GET', `/api/analyses/${id(analysisId)}`, { query: { compare } }),

  assets: (query: AssetsQuery) =>
    request<AssetsOverview>('GET', '/api/assets', { query: toQuery(query) }),
  repoAssets: (repo: RepoRef) =>
    request<RepoAssetsView>('GET', '/api/assets/repo', { query: { repo: repoKey(repo) } }),
  bundles: () => request<BundlesOverview>('GET', '/api/bundles'),
  bundleTargets: (repo: RepoRef) =>
    request<BundleTargetsView>('GET', '/api/bundles/targets', { query: { repo: repoKey(repo) } }),
  bundleReport: (
    repo: RepoRef,
    query: { target: string; version?: string | undefined; analysis?: string | undefined },
  ) =>
    request<BundleTargetReportView>('GET', '/api/bundles/report', {
      query: { repo: repoKey(repo), ...query },
    }),

  applyChanges: (analysisId: string, input: ApplyChangesInput) =>
    request<ApplyChangesResult>('POST', `/api/analyses/${id(analysisId)}/changes`, { body: input }),

  credentials: () => request<CredentialList>('GET', '/api/credentials'),
  createCredential: (input: CreateCredentialInput) =>
    request<CredentialView>('POST', '/api/credentials', { body: input }),
  updateCredential: (credentialId: string, input: UpdateCredentialInput) =>
    request<CredentialView>('PATCH', `/api/credentials/${id(credentialId)}`, { body: input }),
  deleteCredential: (credentialId: string) =>
    request<void>('DELETE', `/api/credentials/${id(credentialId)}`),
  rotateCredential: (credentialId: string) =>
    request<CredentialView>('POST', `/api/credentials/${id(credentialId)}/rotate`),
  credentialModels: (credentialId: string) =>
    request<ProviderModelList>('GET', `/api/credentials/${id(credentialId)}/models`),
  testCredential: (credentialId: string, model?: string) =>
    request<CredentialTestResult>('POST', `/api/credentials/${id(credentialId)}/test`, {
      body: (model ? { model } : {}) satisfies CredentialTestInput,
    }),
  aiProviders: () => request<AiCatalogProviderList>('GET', '/api/ai/providers'),

  settings: () => request<SettingList>('GET', '/api/settings'),
  putSetting: (input: PutSettingInput) =>
    request<SettingView>('PUT', '/api/settings', { body: input }),
  deleteSetting: (settingId: string) => request<void>('DELETE', `/api/settings/${id(settingId)}`),
  resolveSettings: (focus: ScopeFocus) =>
    request<ResolvedSettings>('GET', '/api/settings/resolve', {
      query: focus.kind === 'repo' ? { repo: repoKey(focus.repo) } : { group: focus.group },
    }),

  knowledge: (query: { status?: readonly KnowledgeStatus[]; repo?: RepoRef; q?: string }) =>
    request<KnowledgeList>('GET', '/api/knowledge', {
      query: {
        status: query.status?.length ? query.status.join(',') : undefined,
        repo: query.repo ? repoKey(query.repo) : undefined,
        q: query.q || undefined,
        limit: 500,
      },
    }),
  createKnowledge: (input: CreateKnowledgeInput) =>
    request<KnowledgeEntry>('POST', '/api/knowledge', { body: input }),
  updateKnowledge: (entryId: string, input: UpdateKnowledgeInput) =>
    request<KnowledgeEntry>('PUT', `/api/knowledge/${id(entryId)}`, { body: input }),
  knowledgeEntry: (entryId: string) =>
    request<KnowledgeDetail>('GET', `/api/knowledge/${id(entryId)}`),
  reviewKnowledge: (entryId: string, action: 'accept' | 'reject' | 'archive') =>
    request<KnowledgeEntry>('POST', `/api/knowledge/${id(entryId)}/${action}`),
  deleteKnowledge: (entryId: string) => request<void>('DELETE', `/api/knowledge/${id(entryId)}`),
  knowledgeCounts: () => request<KnowledgeCounts>('GET', '/api/knowledge/counts'),

  guide: (scope: GuideScopeKey) =>
    request<GuideScopeView>('GET', '/api/guide', { query: { scope } }),
  guideSection: (scope: GuideScopeKey, section: GuideSectionName) =>
    request<GuideSectionDetail>('GET', '/api/guide/section', { query: { scope, section } }),
  putGuideSection: (scope: GuideScopeKey, section: GuideSectionName, input: PutGuideSectionInput) =>
    request<GuideSection>('PUT', '/api/guide/section', { query: { scope, section }, body: input }),
  restoreGuideSection: (scope: GuideScopeKey, section: GuideSectionName, version: number) =>
    request<GuideSection>('POST', '/api/guide/section/restore', {
      query: { scope, section, version },
    }),
  acceptGuideSection: (
    scope: GuideScopeKey,
    section: GuideSectionName,
    input: AcceptGuideSectionInput,
  ) =>
    request<GuideSection>('POST', '/api/guide/section/accept', {
      query: { scope, section },
      body: input,
    }),
  regenerateGuide: (repo: RepoRef, input: RegenerateGuideInput) =>
    request<Job>('POST', '/api/guide/regenerate', { query: { repo: repoKey(repo) }, body: input }),
  guidePreview: (repo: RepoRef, task: GuideTask) =>
    request<GuidePreview>('GET', '/api/guide/preview', { query: { repo: repoKey(repo), task } }),
  guideChain: (repo: RepoRef, section?: GuideSectionName) =>
    request<GuideChainView>('GET', '/api/guide/chain', {
      query: { repo: repoKey(repo), section },
    }),
  guideRepoFiles: (repo: RepoRef) =>
    request<GuideRepoFilesView>('GET', '/api/guide/repo-files', {
      query: { repo: repoKey(repo) },
    }),
  guideGeneratedHistory: (scope: GuideScopeKey, section: GuideSectionName) =>
    request<GuideGeneratedHistory>('GET', '/api/guide/generated/history', {
      query: { scope, section },
    }),

  families: () => request<FamilyList>('GET', '/api/families'),
  familySuggestions: () => request<FamilySuggestionList>('GET', '/api/families/suggestions'),
  dismissFamilySuggestion: (input: FamilySuggestionDismissInput) =>
    request<void>('POST', '/api/families/suggestions/dismiss', { body: input }),
  createFamily: (input: FamilyInput) => request<Family>('POST', '/api/families', { body: input }),
  updateFamily: (familyId: string, input: FamilyInput) =>
    request<Family>('PUT', `/api/families/${id(familyId)}`, { body: input }),
  deleteFamily: (familyId: string) => request<void>('DELETE', `/api/families/${id(familyId)}`),

  learnings: (query: { repo?: RepoRef; status?: readonly LearningStatus[] }) =>
    request<LearningList>('GET', '/api/learnings', {
      query: {
        repo: query.repo ? repoKey(query.repo) : undefined,
        status: query.status?.length ? query.status.join(',') : undefined,
      },
    }),
  acceptLearning: (candidateId: string, input: AcceptLearningInput) =>
    request<LearningCandidate>('POST', `/api/learnings/${id(candidateId)}/accept`, {
      body: input,
    }),
  acceptLearnings: (input: AcceptLearningsInput) =>
    request<AcceptLearningsResult>('POST', '/api/learnings/accept', { body: input }),
  rejectLearning: (candidateId: string) =>
    request<LearningCandidate>('POST', `/api/learnings/${id(candidateId)}/reject`),
  editLearning: (candidateId: string, input: EditLearningInput) =>
    request<LearningCandidate>('PATCH', `/api/learnings/${id(candidateId)}`, { body: input }),
  reactions: (repo?: RepoRef) =>
    request<ReactionTotalsList>('GET', '/api/learnings/reactions', {
      query: { repo: repo ? repoKey(repo) : undefined },
    }),

  forges: () => request<ConfigEntryList<'forge'>>('GET', '/api/config/forges'),
  putForge: (forgeId: string, data: PutConfigInput['forge']) =>
    request<ConfigEntryView<'forge'>>('PUT', `/api/config/forges/${id(forgeId)}`, { body: data }),
  deleteForge: (forgeId: string) => request<void>('DELETE', `/api/config/forges/${id(forgeId)}`),
  issueForgeSshKey: (forgeId: string, input: ForgeSshKeyInput) =>
    request<ForgeSshKeyResult>('POST', `/api/forges/${id(forgeId)}/ssh-key`, { body: input }),
  removeForgeSshKey: (forgeId: string) =>
    request<void>('DELETE', `/api/forges/${id(forgeId)}/ssh-key`),
  forgeAccount: (forgeId: string) =>
    request<ForgeAccountView>('GET', `/api/forges/${id(forgeId)}/account`),
  setForgeAvatar: (forgeId: string, file: File) =>
    uploadFile<ForgeAccountView>('PUT', `/api/forges/${id(forgeId)}/account/avatar`, file, {
      filename: file.name,
    }),
  forgeRepositories: (forgeId: string, search: string) =>
    request<ForgeRepositoryList>('GET', `/api/forges/${id(forgeId)}/repositories`, {
      query: { search: search || undefined, limit: 30 },
    }),
  checkRepoAccess: (forgeId: string, input: RepoAccessBatchInput) =>
    request<RepoAccessBatch>('POST', `/api/forges/${id(forgeId)}/repositories/access`, {
      body: input,
    }),
  groups: () => request<ConfigEntryList<'group'>>('GET', '/api/config/groups'),
  putGroup: (groupId: string, data: GroupDocumentData) =>
    request<ConfigEntryView<'group'>>('PUT', `/api/config/groups/${id(groupId)}`, { body: data }),

  configEntries: <C extends keyof ConfigCollections>(collection: C) =>
    request<ConfigEntryList<ConfigCollections[C]>>('GET', `/api/config/${collection}`),
  putConfigEntry: <C extends keyof ConfigCollections>(
    collection: C,
    entryId: string,
    data: PutConfigInput[ConfigCollections[C]],
  ) =>
    request<ConfigEntryView<ConfigCollections[C]>>(
      'PUT',
      `/api/config/${collection}/${id(entryId)}`,
      { body: data },
    ),
  deleteConfigEntry: (collection: keyof ConfigCollections, entryId: string) =>
    request<void>('DELETE', `/api/config/${collection}/${id(entryId)}`),
  issueForgeWebhook: (forgeId: string, input: ForgeWebhookInput) =>
    request<ForgeWebhookResult>('POST', `/api/forges/${id(forgeId)}/webhook`, { body: input }),
  scheduleRuns: (limit = 10) =>
    request<ScheduleRunList>('GET', '/api/schedules/runs', { query: { limit } }),
  runSchedule: (scheduleId: string) =>
    request<ScheduleRunStarted>('POST', `/api/schedules/${id(scheduleId)}/run`),
  runNewRepoTrigger: () => request<ScheduleRunStarted>('POST', '/api/triggers/new-repo/run'),
  freshnessOverview: () => request<FreshnessOverview>('GET', '/api/automation/freshness'),
  backfillAnalyses: (input: AnalysisBackfillInput) =>
    request<AnalysisBackfillStarted>('POST', '/api/analyses/backfill', { body: input }),
  releaseOverview: (refresh = false) =>
    request<ReleaseOverview>('GET', '/api/releases/overview', {
      query: { refresh: refresh ? 1 : undefined },
    }),
  releaseTimeline: (repo: RepoRef, offset = 0, limit = 10) =>
    request<ReleaseTimelineView>('GET', '/api/releases/timeline', {
      query: { repo: repoKey(repo), offset, limit },
    }),
  releaseVersion: (repo: RepoRef, tag: string) =>
    request<ReleaseVersionDetailView>('GET', '/api/releases/version', {
      query: { repo: repoKey(repo), tag },
    }),
  releaseRepo: (repo: RepoRef) =>
    request<ReleaseRepoView>('GET', '/api/releases/repo', { query: { repo: repoKey(repo) } }),
  releaseDetect: (repo: RepoRef) =>
    request<ReleaseDetectView>('GET', '/api/releases/detect', { query: { repo: repoKey(repo) } }),
  releaseDeploy: (repo: RepoRef, tag: string) =>
    request<DeployState>('GET', '/api/releases/deploy', { query: { repo: repoKey(repo), tag } }),
  saveReleaseEdits: (input: ReleaseEditsInput) =>
    request<{ ok: true }>('PUT', '/api/releases/edits', { body: input }),
  writeReleaseSummary: (input: ReleaseSummaryInput) =>
    request<{ markdown: string }>('POST', '/api/releases/summary', { body: input }),
  runReleaseStep: (step: 'propose' | 'version', input: ReleaseStepInput) =>
    request<ReleaseStepResult>('POST', `/api/releases/${step}`, { body: input }),
  acceptRelease: (input: ReleaseAcceptInput) =>
    request<ReleaseStepResult>('POST', '/api/releases/accept', { body: input }),
  withdrawRelease: (repo: RepoRef) =>
    request<{ ok: true }>('DELETE', '/api/releases/accept', { query: { repo: repoKey(repo) } }),
  startReleaseDeploy: (input: ReleaseDeployInput) =>
    request<ReleaseStepResult>('POST', '/api/releases/deploy', { body: input }),
  repoAvatarUrl: (repo: RepoRef, version?: number) =>
    urlOf('/api/repos/avatar', { repo: repoKey(repo), v: version || undefined }),
  repoAvatarInfo: (repo: RepoRef) =>
    request<RepoAvatarInfo>('GET', '/api/repos/avatar/info', { query: { repo: repoKey(repo) } }),
  setRepoAvatar: (repo: RepoRef, file: Blob) =>
    uploadFile<RepoAvatarInfo>('PUT', '/api/repos/avatar', file, { repo: repoKey(repo) }),
  removeRepoAvatar: (repo: RepoRef) =>
    request<undefined>('DELETE', '/api/repos/avatar', { query: { repo: repoKey(repo) } }),
  repoOverview: (repo: RepoRef) =>
    request<RepoOverview>('GET', '/api/repos/overview', { query: { repo: repoKey(repo) } }),
  reviews: (query: ReviewQuery) =>
    request<ReviewList>('GET', '/api/reviews', { query: toQuery(query) }),
  review: (analysisId: string) => request<ReviewDetail>('GET', `/api/reviews/${id(analysisId)}`),
  branches: () => request<BranchesOverview>('GET', '/api/branches'),

  jobAnalyzers: () => request<JobAnalyzerList>('GET', '/api/jobs/analyzers'),
  jobs: (filter: JobQuery & { limit?: number; before?: string }) =>
    request<JobList>('GET', '/api/jobs', {
      query: { ...jobQuery(filter), limit: filter.limit, before: filter.before },
    }),
  jobCount: (filter: JobQuery & { since?: string }) =>
    request<JobCountView>('GET', '/api/jobs/count', {
      query: { ...jobQuery(filter), since: filter.since },
    }),
  jobStats: (filter: { repos?: readonly string[] } = {}) =>
    request<JobStats>('GET', '/api/jobs/stats', { query: { repos: filter.repos?.join(',') } }),
  jobTargets: () => request<JobTargetList>('GET', '/api/jobs/targets'),
  jobFailures: (filter: { days?: number; analyzer?: string; repos?: readonly string[] }) =>
    request<JobFailureList>('GET', '/api/jobs/failures', {
      query: { days: filter.days, analyzer: filter.analyzer, repos: filter.repos?.join(',') },
    }),
  job: (jobId: string) => request<Job>('GET', `/api/jobs/${id(jobId)}`),
  jobWhy: (jobId: string) => request<JobWhy>('GET', `/api/jobs/${id(jobId)}/why`),
  jobRuns: (jobId: string) => request<JobRunList>('GET', `/api/jobs/${id(jobId)}/runs`),
  jobTranscript: (jobId: string, ref: string) =>
    request<AgentTranscriptView>('GET', `/api/jobs/${id(jobId)}/transcripts/${id(ref)}`),
  jobLog: (
    jobId: string,
    page: { attempt?: number; offset?: number; limit?: number; tail?: number },
  ) => request<JobLog>('GET', `/api/jobs/${id(jobId)}/log`, { query: page }),
  createJob: (input: CreateJobInput) => request<Job>('POST', '/api/jobs', { body: input }),
  cancelJob: (jobId: string) => request<Job>('POST', `/api/jobs/${id(jobId)}/cancel`),

  aiOverview: (query: AiOverviewQuery = {}) =>
    request<AiUsageOverview>('GET', '/api/ai/overview', { query: toQuery(query) }),
  aiWeek: (query: { week?: string; groups?: string } = {}) =>
    request<AiWeekBreakdown>('GET', '/api/ai/week', { query: toQuery(query) }),
  aiUsage: (filter: AiUsageQuery & { groupBy?: string }) =>
    request<AiUsageBuckets>('GET', '/api/ai/usage', { query: toQuery(filter) }),
  aiRuns: (filter: AiUsageQuery & { before?: string; limit?: number }) =>
    request<AiRunList>('GET', '/api/ai/runs', { query: toQuery(filter) }),

  history: (filter: HistoryQuery & { cursor?: string; limit?: number }) =>
    request<HistoryList>('GET', '/api/history', { query: toQuery(filter) }),
  historyScope: () => request<HistoryScope>('GET', '/api/history/scope'),
  verifyAuditLog: (range: { fromSeq?: number; toSeq?: number } = {}) =>
    request<AuditVerifyResponse>('GET', '/api/audit/verify', { query: toQuery(range) }),
  auditLogExportUrl: (filter: HistoryQuery, format: 'csv' | 'ndjson') =>
    urlOf('/api/audit/export', { ...toQuery(filter), format }),

  storage: () => request<StorageOverview>('GET', '/api/storage'),
  database: () => request<DatabaseView>('GET', '/api/database'),
  databaseQueries: (query: { sort: DatabaseQuerySort; limit?: number }) =>
    request<DatabaseQueries>('GET', '/api/database/queries', { query: toQuery(query) }),
  resetDatabaseQueries: () =>
    request<{ ok: true }>('POST', '/api/database/queries/reset', { body: {} }),
  databaseSessions: () => request<DatabaseSessionsView>('GET', '/api/database/sessions'),
  clearStorage: (providerId: string, input: ClearStorageInput = {}) =>
    request<ClearStorageResult>('POST', `/api/storage/${id(providerId)}/clear`, { body: input }),

  libraryIndex: (query: { q?: string; ecosystem?: string }) =>
    request<LibraryIndexStatus>('GET', '/api/system/library-index', { query }),
  reindexLibraries: () =>
    request<LibraryReindexResult>('POST', '/api/system/library-index/reindex'),
  githubTokens: (days: number) =>
    request<GitHubTokenUsage>('GET', '/api/system/library-index/github', { query: { days } }),

  egressCache: () => request<EgressCacheView>('GET', '/api/egress/cache'),
  deleteEgressCache: (input: DeleteEgressCacheInput = {}) =>
    request<DeleteEgressCacheResult>('POST', '/api/egress/cache/delete', { body: input }),

  slackSettings: () => request<SlackSettingsView>('GET', '/api/slack'),
  connectSlack: (input: SlackConnectInput) =>
    request<SlackSettingsView>('PUT', '/api/slack/connection', { body: input }),
  disconnectSlack: () => request<SlackSettingsView>('DELETE', '/api/slack/connection'),
  setSlackEmoji: (input: SlackEmojiInput) =>
    request<SlackSettingsView>('PUT', '/api/slack/emoji', { body: input }),

  createTaskGroup: (input: AgentTaskGroupInput) =>
    request<AgentTaskGroupView>('POST', '/api/task-groups', { body: input }),
  approveTaskGroup: (groupId: string) =>
    request<AgentTaskGroupView>('POST', `/api/task-groups/${id(groupId)}/approve`),
  cancelTaskGroup: (groupId: string) =>
    request<AgentTaskGroupView>('POST', `/api/task-groups/${id(groupId)}/cancel`),
  rejectTaskGroup: (groupId: string) =>
    request<AgentTaskGroupView>('POST', `/api/task-groups/${id(groupId)}/reject`),
  retryTaskGroup: (groupId: string) =>
    request<AgentTaskGroupView>('POST', `/api/task-groups/${id(groupId)}/retry`),
  taskApprovalCount: () => request<TaskApprovalCount>('GET', '/api/task-groups/needs-approval'),
  taskGroups: (query: { limit?: number; source?: string; repo?: string } = {}) =>
    request<AgentTaskGroupList>('GET', '/api/task-groups', { query }),
  taskGroup: (groupId: string) =>
    request<AgentTaskGroupDetail>('GET', `/api/task-groups/${id(groupId)}`),
  decideTaskRepo: (groupId: string, input: { repo: string; approve: boolean }) =>
    request<AgentTaskGroupView>('POST', `/api/task-groups/${id(groupId)}/requests`, {
      body: input,
    }),
  retryTask: (taskId: string) =>
    request<AgentTaskGroupView>('POST', `/api/tasks/${id(taskId)}/retry`),
  cancelTask: (taskId: string) =>
    request<AgentTaskGroupView>('POST', `/api/tasks/${id(taskId)}/cancel`),
  writeTasks: () => request<WriteTasksStatus>('GET', '/api/write-tasks'),

  chatThreads: (archived = false, q?: string) =>
    request<ChatThreadList>('GET', '/api/chat/threads', {
      query: { archived: archived ? 'true' : undefined, q: q?.trim() || undefined },
    }),
  chatContext: (threadId: string) =>
    request<ChatThreadContextView>('GET', `/api/chat/threads/${id(threadId)}/context`),
  chatExportUrl: (threadId: string) => urlOf(`/api/chat/threads/${id(threadId)}/export`),
  createChatThread: (input: ChatThreadInput) =>
    request<ChatThreadView>('POST', '/api/chat/threads', { body: input }),
  updateChatThread: (threadId: string, input: ChatThreadPatchInput) =>
    request<ChatThreadView>('PATCH', `/api/chat/threads/${id(threadId)}`, { body: input }),
  chatMessages: (
    threadId: string,
    query: { before?: number; after?: number; changedSince?: string; limit?: number } = {},
  ) => request<ChatMessageList>('GET', `/api/chat/threads/${id(threadId)}/messages`, { query }),
  chatPeople: (threadId: string) =>
    request<ChatPeopleView>('GET', `/api/chat/threads/${id(threadId)}/people`),
  chatTranscript: (messageId: string) =>
    request<AgentTranscriptView>('GET', `/api/chat/messages/${id(messageId)}/transcript`),
  postChat: (threadId: string, input: ChatPostInput) =>
    request<ChatPostResult>('POST', `/api/chat/threads/${id(threadId)}/messages`, { body: input }),
  markChatRead: (threadId: string, input: ChatReadInput) =>
    request<void>('POST', `/api/chat/threads/${id(threadId)}/read`, { body: input }),
  chatUnread: () => request<ChatUnreadView>('GET', '/api/chat/unread'),

  accounts: () => request<ExternalAccountList>('GET', '/api/accounts'),
  linkAccount: (input: LinkAccountInput) =>
    request<ExternalAccountView>('POST', '/api/accounts', { body: input }),
  unlinkAccount: (accountId: string) => request<void>('DELETE', `/api/accounts/${id(accountId)}`),
  accountChallenge: (accountId: string) =>
    request<AccountChallenge>('POST', `/api/accounts/${id(accountId)}/challenge`),

  artifactUrl: (artifactId: string) => urlOf(`/api/artifacts/${id(artifactId)}`),
  mediaVariants: (input: MediaVariantsInput) =>
    request<MediaVariantsResult>('POST', '/api/media/variants', { body: input }),
  applyMedia: (input: MediaApplyInput & { mode: 'merge-request' }) =>
    request<MediaApplyResult>('POST', '/api/media/apply', { body: input }),
  mediaZip: (input: MediaApplyInput & { mode: 'zip' }) =>
    requestBlob('POST', '/api/media/apply', { body: input }),

  passwordLogin: (password: string) =>
    request<void>('POST', '/auth/password/login', { body: { password } }),
  logout: (url: string) => request<void>('POST', url),

  passkeyLoginOptions: () =>
    request<PublicKeyCredentialRequestOptionsJSON>('POST', '/auth/users/passkey/login/options'),
  passkeyLoginVerify: (response: AuthenticationResponseJSON) =>
    request<void>('POST', '/auth/users/passkey/login/verify', { body: { response } }),

  linkInfo: (token: string) => request<LinkInfo>('GET', `/auth/users/link/${id(token)}`),
  linkRegisterOptions: (token: string) =>
    request<PublicKeyCredentialCreationOptionsJSON>(
      'POST',
      `/auth/users/link/${id(token)}/register/options`,
    ),
  linkRegisterVerify: (token: string, response: RegistrationResponseJSON, label?: string) =>
    request<void>('POST', `/auth/users/link/${id(token)}/register/verify`, {
      body: { response, ...(label ? { label } : {}) },
    }),

  account: () => request<UserView>('GET', '/auth/users/me'),
  setAvatar: (seed: string | null) =>
    request<MePrincipal>('PUT', '/api/me/avatar', { body: { seed } satisfies SetAvatarInput }),
  preferences: () => request<UserPreferences>('GET', '/api/me/preferences'),
  setPreferences: (input: UserPreferencesInput) =>
    request<UserPreferences>('PUT', '/api/me/preferences', { body: input }),
  addPasskeyOptions: () =>
    request<PublicKeyCredentialCreationOptionsJSON>('POST', '/auth/users/me/passkeys/options'),
  addPasskeyVerify: (response: RegistrationResponseJSON, label?: string) =>
    request<UserView>('POST', '/auth/users/me/passkeys/verify', {
      body: { response, ...(label ? { label } : {}) },
    }),
  renameOwnPasskey: (passkeyId: string, label: string) =>
    request<UserView>('PATCH', `/auth/users/me/passkeys/${id(passkeyId)}`, { body: { label } }),
  removeOwnPasskey: (passkeyId: string) =>
    request<void>('DELETE', `/auth/users/me/passkeys/${id(passkeyId)}`),

  users: () => request<UserList>('GET', '/auth/users/admin/users'),
  inviteUser: (input: InviteUserInput) =>
    request<LinkResponse>('POST', '/auth/users/admin/users', { body: input }),
  updateUser: (userId: string, input: UpdateUserInput) =>
    request<UserView>('PATCH', `/auth/users/admin/users/${id(userId)}`, { body: input }),
  recoveryLink: (userId: string) =>
    request<LinkResponse>('POST', `/auth/users/admin/users/${id(userId)}/recovery`),
  deletePasskey: (userId: string, passkeyId: string) =>
    request<void>('DELETE', `/auth/users/admin/users/${id(userId)}/passkeys/${id(passkeyId)}`),
}
