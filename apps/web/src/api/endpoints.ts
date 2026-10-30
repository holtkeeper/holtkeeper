import type {
  ActivityList,
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
  PutConfigInput,
  AuditRunDetail,
  AuditRunList,
  CreateCredentialInput,
  CredentialList,
  CredentialTestInput,
  CredentialTestResult,
  CredentialView,
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
  RepoRef,
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
import { request } from './client.ts'

const id = (value: string) => encodeURIComponent(value)

/** Every server endpoint the UI uses. Nothing outside `src/api/` knows a URL. */
export const api = {
  me: (signal?: AbortSignal) => request<MeResponse>('GET', '/api/me', signal ? { signal } : {}),

  repos: () => request<RepoList>('GET', '/api/repos'),

  auditRuns: (query: { repo?: RepoRef; limit?: number; before?: string }) =>
    request<AuditRunList>('GET', '/api/audit-runs', {
      query: {
        repo: query.repo ? repoKey(query.repo) : undefined,
        limit: query.limit,
        before: query.before,
      },
    }),
  auditRun: (runId: string) => request<AuditRunDetail>('GET', `/api/audit-runs/${id(runId)}`),

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
