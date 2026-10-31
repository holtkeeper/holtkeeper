import type {
  AccountChallenge,
  ActivityList,
  AiRunList,
  AiUsageBuckets,
  AiUsageOverview,
  AuditList,
  AuditVerifyResponse,
  ClearStorageInput,
  ClearStorageResult,
  CreateMcpTokenInput,
  CreateMcpTokenResult,
  McpTokenList,
  McpUsageOverview,
  PublicApiDiff,
  PublicApiPackageDetail,
  PublicApiPackageList,
  PublicApiSearchResult,
  PackageUsageView,
  RepoUsageView,
  UpgradeImpactView,
  UsageSitesView,
  ConfigEntryDetail,
  CreateJobInput,
  ExternalAccountList,
  ExternalAccountView,
  ForgeWebhookInput,
  ForgeWebhookResult,
  Job,
  JobAnalyzerList,
  JobList,
  LinkAccountInput,
  MediaApplyInput,
  MediaApplyResult,
  MediaVariantsInput,
  MediaVariantsResult,
  RepoExplain,
  RuntimeConfigView,
  ReleaseBackfillInput,
  ReleaseBackfillStarted,
  RepoAvatarInfo,
  SchedulePreview,
  ScheduleRunList,
  ScheduleRunStarted,
  StorageOverview,
  AiCatalogProviderList,
  AnalysisDetail,
  AnalysisKindList,
  AnalysisList,
  ApplyChangesInput,
  ApplyChangesResult,
  ConfigEntryList,
  ConfigEntryView,
  CreateKnowledgeInput,
  ForgeSshKeyInput,
  ForgeSshKeyResult,
  GroupDocumentData,
  GroupListingView,
  PutConfigInput,
  AuditRunDetail,
  AuditRunList,
  CreateCredentialInput,
  CredentialList,
  CredentialTestInput,
  CredentialTestResult,
  CredentialView,
  DependencyInventory,
  InviteUserInput,
  KnowledgeEntry,
  KnowledgeList,
  KnowledgeStatus,
  LinkInfo,
  LinkResponse,
  MePrincipal,
  MeResponse,
  ProviderModelList,
  PutSettingInput,
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
  UserView,
} from '@holtkeeper/api'
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser'

import { repoKey } from '../lib/repo.ts'
import { request, requestBlob, uploadFile, urlOf } from './client.ts'

const id = (value: string) => encodeURIComponent(value)

/** Config collections of `/api/config/<collection>` and the document type each holds. */
export interface ConfigCollections {
  forges: 'forge'
  groups: 'group'
  'repo-traits': 'repoTraits'
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

/** Filters of `GET /api/audit` and its export. */
export interface AuditLogQuery {
  actor?: string
  action?: string
  targetType?: string
  targetId?: string
  repo?: string
  outcome?: string
  via?: string
  from?: string
  to?: string
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

  dependencies: () => request<DependencyInventory>('GET', '/api/dependencies'),

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
  repoUsage: (repo: string) =>
    request<RepoUsageView>('GET', '/api/api-surface/usages/repo', { query: { repo } }),
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
  aiProviderModels: (providerId: string) =>
    request<ProviderModelList>('GET', `/api/ai/providers/${id(providerId)}/models`),

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

  forges: () => request<ConfigEntryList<'forge'>>('GET', '/api/config/forges'),
  putForge: (forgeId: string, data: PutConfigInput['forge']) =>
    request<ConfigEntryView<'forge'>>('PUT', `/api/config/forges/${id(forgeId)}`, { body: data }),
  deleteForge: (forgeId: string) => request<void>('DELETE', `/api/config/forges/${id(forgeId)}`),
  issueForgeSshKey: (forgeId: string, input: ForgeSshKeyInput) =>
    request<ForgeSshKeyResult>('POST', `/api/forges/${id(forgeId)}/ssh-key`, { body: input }),
  removeForgeSshKey: (forgeId: string) =>
    request<void>('DELETE', `/api/forges/${id(forgeId)}/ssh-key`),
  groups: () => request<ConfigEntryList<'group'>>('GET', '/api/config/groups'),
  putGroup: (groupId: string, data: GroupDocumentData) =>
    request<ConfigEntryView<'group'>>('PUT', `/api/config/groups/${id(groupId)}`, { body: data }),

  configEntries: <C extends keyof ConfigCollections>(collection: C) =>
    request<ConfigEntryList<ConfigCollections[C]>>('GET', `/api/config/${collection}`),
  configEntry: <C extends keyof ConfigCollections>(collection: C, entryId: string) =>
    request<ConfigEntryDetail<ConfigCollections[C]>>(
      'GET',
      `/api/config/${collection}/${id(entryId)}`,
    ),
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
  backfillReleases: (input: ReleaseBackfillInput) =>
    request<ReleaseBackfillStarted>('POST', '/api/releases/backfill', { body: input }),
  configExportUrl: () => urlOf('/api/config/export'),
  runtimeConfig: () => request<RuntimeConfigView>('GET', '/api/config/runtime'),
  repoAvatarUrl: (repo: RepoRef, version?: number) =>
    urlOf('/api/repos/avatar', { repo: repoKey(repo), v: version || undefined }),
  repoAvatarInfo: (repo: RepoRef) =>
    request<RepoAvatarInfo>('GET', '/api/repos/avatar/info', { query: { repo: repoKey(repo) } }),
  setRepoAvatar: (repo: RepoRef, file: Blob) =>
    uploadFile<RepoAvatarInfo>('PUT', '/api/repos/avatar', file, { repo: repoKey(repo) }),
  removeRepoAvatar: (repo: RepoRef) =>
    request<undefined>('DELETE', '/api/repos/avatar', { query: { repo: repoKey(repo) } }),
  explainRepo: (repo: RepoRef) =>
    request<RepoExplain>('GET', '/api/repos/explain', { query: { repo: repoKey(repo) } }),

  jobAnalyzers: () => request<JobAnalyzerList>('GET', '/api/jobs/analyzers'),
  jobs: (filter: {
    status?: string
    repo?: RepoRef
    schedule?: string
    limit?: number
    before?: string
  }) =>
    request<JobList>('GET', '/api/jobs', {
      query: {
        status: filter.status,
        repo: filter.repo ? repoKey(filter.repo) : undefined,
        schedule: filter.schedule,
        limit: filter.limit,
        before: filter.before,
      },
    }),
  job: (jobId: string) => request<Job>('GET', `/api/jobs/${id(jobId)}`),
  createJob: (input: CreateJobInput) => request<Job>('POST', '/api/jobs', { body: input }),
  cancelJob: (jobId: string) => request<Job>('POST', `/api/jobs/${id(jobId)}/cancel`),

  aiOverview: () => request<AiUsageOverview>('GET', '/api/ai/overview'),
  aiUsage: (filter: AiUsageQuery & { groupBy?: string }) =>
    request<AiUsageBuckets>('GET', '/api/ai/usage', { query: toQuery(filter) }),
  aiRuns: (filter: AiUsageQuery & { before?: string; limit?: number }) =>
    request<AiRunList>('GET', '/api/ai/runs', { query: toQuery(filter) }),

  auditLog: (filter: AuditLogQuery & { cursor?: string; limit?: number }) =>
    request<AuditList>('GET', '/api/audit', { query: toQuery(filter) }),
  auditLogCount: (filter: AuditLogQuery) =>
    request<{ count: number }>('GET', '/api/audit/count', { query: toQuery(filter) }),
  verifyAuditLog: (range: { fromSeq?: number; toSeq?: number } = {}) =>
    request<AuditVerifyResponse>('GET', '/api/audit/verify', { query: toQuery(range) }),
  auditLogExportUrl: (filter: AuditLogQuery, format: 'csv' | 'ndjson') =>
    urlOf('/api/audit/export', { ...toQuery(filter), format }),

  storage: () => request<StorageOverview>('GET', '/api/storage'),
  clearStorage: (providerId: string, input: ClearStorageInput = {}) =>
    request<ClearStorageResult>('POST', `/api/storage/${id(providerId)}/clear`, { body: input }),

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

  activity: (query: { before?: string; limit?: number }) =>
    request<ActivityList>('GET', '/api/activity', { query }),

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
