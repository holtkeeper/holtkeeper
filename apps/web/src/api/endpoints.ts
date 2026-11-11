import type {
  AcceptGuideSectionInput,
  AgentTaskGroupDetail,
  AgentTaskGroupInput,
  AgentTaskGroupList,
  AgentTaskGroupView,
  WriteTasksStatus,
  AcceptLearningInput,
  AgentTranscriptView,
  EditLearningInput,
  Family,
  FamilyInput,
  FamilyList,
  FamilySuggestionDismissInput,
  FamilySuggestionList,
  GuidePreview,
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
  ChatThreadList,
  ChatThreadPatchInput,
  ChatThreadView,
  ChatUnreadView,
  SlackConnectInput,
  SlackSettingsView,
  AccountChallenge,
  AiRunList,
  AiUsageBuckets,
  AiUsageOverview,
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
  PackageUsageView,
  UpgradeImpactView,
  UsageSitesView,
  CreateJobInput,
  ExternalAccountList,
  ExternalAccountView,
  ForgeWebhookInput,
  ForgeWebhookResult,
  Job,
  JobAnalyzerList,
  JobFailureList,
  JobList,
  JobLog,
  JobRunList,
  JobTargetList,
  JobWhy,
  LinkAccountInput,
  MediaApplyInput,
  MediaApplyResult,
  MediaVariantsInput,
  MediaVariantsResult,
  RepoOverview,
  RepoReviewList,
  ReleaseAcceptInput,
  ReleaseOverview,
  ReleaseDeployInput,
  ReleaseEditsInput,
  ReleaseRepoView,
  ReleaseStepInput,
  ReleaseTimelineView,
  ReleaseVersionDetailView,
  ReleaseStepResult,
  ReleaseSummaryInput,
  DeployState,
  RepoAvatarInfo,
  SchedulePreview,
  FreshnessOverview,
  ScheduleRunList,
  ScheduleRunStarted,
  StorageOverview,
  AiCatalogProviderList,
  AnalysisDetail,
  BundleTargetReportView,
  BundleTargetsView,
  AnalysisKindList,
  AnalysisList,
  ApplyChangesInput,
  ApplyChangesResult,
  ConfigEntryList,
  ConfigEntryView,
  CreateKnowledgeInput,
  ForgeRepositoryList,
  ForgeSshKeyInput,
  ForgeSshKeyResult,
  GitHubTokenUsage,
  GroupDocumentData,
  GroupListingView,
  HistoryList,
  HomeView,
  HistoryScope,
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
  RepoAccessView,
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
  analyzer?: string
  outcome?: string
  from?: string
  to?: string
}

/** Filters of `GET /api/history` and the audit export; `repos` is a comma list. */
export interface HistoryQuery {
  actor?: string
  action?: string
  repos?: string
  outcome?: string
  from?: string
}

type Query = Record<string, string | number | undefined>
const toQuery = (value: object): Query =>
  Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string | number] =>
        typeof entry[1] === 'string' || typeof entry[1] === 'number',
    ),
  )

/** Every server endpoint the UI uses. Nothing outside `src/api/` knows a URL. */
export const api = {
  me: (signal?: AbortSignal) => request<MeResponse>('GET', '/api/me', signal ? { signal } : {}),

  home: () => request<HomeView>('GET', '/api/home'),
  repos: () => request<RepoList>('GET', '/api/repos'),
  repoUpdates: (repo: string) =>
    request<RepoUpdatesView>('GET', '/api/repos/updates', { query: { repo } }),
  pollRepo: (repo: string) =>
    request<RepoPollResult>('POST', '/api/repos/updates/poll', { body: { repo } }),
  issueRepoWebhook: (input: RepoWebhookInput) =>
    request<RepoUpdatesView>('POST', '/api/repos/updates/webhook', { body: input }),
  removeRepoWebhook: (repo: string) =>
    request<void>('DELETE', '/api/repos/updates/webhook', { query: { repo } }),
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

  dependencies: () => request<DependencyTable>('GET', '/api/dependencies'),
  stack: () => request<StackOverview>('GET', '/api/stack'),
  dependency: (ecosystem: string, name: string) =>
    request<DependencyDetail>('GET', '/api/dependencies/library', { query: { ecosystem, name } }),
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
  publicApiSearch: (query: { q: string; package?: string; kind?: string; limit?: number }) =>
    request<PublicApiSearchResult>('GET', '/api/api-surface/search', { query: toQuery(query) }),
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
  upgradeImpact: (query: { package: string; from?: string; to?: string; repo?: string }) =>
    request<UpgradeImpactView>('GET', '/api/api-surface/usages/impact', {
      query: toQuery(query),
    }),
  publicApiRescan: () => request<{ indexedAt?: string }>('POST', '/api/api-surface/rescan'),
  mcpTokens: () => request<McpTokenList>('GET', '/api/api-surface/mcp/tokens'),
  createMcpToken: (input: CreateMcpTokenInput) =>
    request<CreateMcpTokenResult>('POST', '/api/api-surface/mcp/tokens', { body: input }),
  revokeMcpToken: (tokenId: string) =>
    request<void>('DELETE', `/api/api-surface/mcp/tokens/${id(tokenId)}`),
  mcpUsage: (days: number) =>
    request<McpUsageOverview>('GET', '/api/api-surface/mcp/usage', { query: { days } }),
  mcpTools: () => mcpRequest<{ tools: McpTool[] }>('tools/list').then((result) => result.tools),

  analysisKinds: () => request<AnalysisKindList>('GET', '/api/analyses/kinds'),
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

  repoAssets: (repo: RepoRef) =>
    request<RepoAssetsView>('GET', '/api/assets/repo', { query: { repo: repoKey(repo) } }),
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
  resolveSettings: (repo: RepoRef) =>
    request<ResolvedSettings>('GET', '/api/settings/resolve', { query: { repo: repoKey(repo) } }),

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
  reviewKnowledge: (entryId: string, action: 'accept' | 'reject' | 'archive') =>
    request<KnowledgeEntry>('POST', `/api/knowledge/${id(entryId)}/${action}`),
  deleteKnowledge: (entryId: string) => request<void>('DELETE', `/api/knowledge/${id(entryId)}`),

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
  forgeRepositories: (forgeId: string, search: string) =>
    request<ForgeRepositoryList>('GET', `/api/forges/${id(forgeId)}/repositories`, {
      query: { search: search || undefined, limit: 30 },
    }),
  repoAccess: (forgeId: string, path: string) =>
    request<RepoAccessView>('GET', `/api/forges/${id(forgeId)}/repositories/access`, {
      query: { path },
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
  schedulePreview: (scheduleId: string, count = 10) =>
    request<SchedulePreview>('GET', `/api/schedules/${id(scheduleId)}/preview`, {
      query: { count },
    }),
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
  repoReviews: (repo: RepoRef) =>
    request<RepoReviewList>('GET', '/api/repos/reviews', { query: { repo: repoKey(repo) } }),

  jobAnalyzers: () => request<JobAnalyzerList>('GET', '/api/jobs/analyzers'),
  jobs: (filter: JobQuery & { limit?: number; before?: string }) =>
    request<JobList>('GET', '/api/jobs', {
      query: {
        status: filter.status,
        repo: filter.repo ? repoKey(filter.repo) : undefined,
        repos: filter.repos?.join(','),
        analyzer: filter.analyzer,
        trigger: filter.trigger,
        schedule: filter.schedule,
        signature: filter.signature,
        limit: filter.limit,
        before: filter.before,
      },
    }),
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

  aiOverview: () => request<AiUsageOverview>('GET', '/api/ai/overview'),
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

  createTaskGroup: (input: AgentTaskGroupInput) =>
    request<AgentTaskGroupView>('POST', '/api/task-groups', { body: input }),
  approveTaskGroup: (groupId: string) =>
    request<AgentTaskGroupView>('POST', `/api/task-groups/${id(groupId)}/approve`),
  cancelTaskGroup: (groupId: string) =>
    request<AgentTaskGroupView>('POST', `/api/task-groups/${id(groupId)}/cancel`),
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

  chatThreads: (archived = false) =>
    request<ChatThreadList>('GET', '/api/chat/threads', {
      query: archived ? { archived: 'true' } : {},
    }),
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
