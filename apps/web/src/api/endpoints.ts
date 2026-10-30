import type {
  ActivityList,
  AnalysisDetail,
  AnalysisKindList,
  AnalysisList,
  ApplyChangesInput,
  ApplyChangesResult,
  AuditRunDetail,
  AuditRunList,
  CreateCredentialInput,
  CredentialList,
  CredentialView,
  InviteUserInput,
  LinkInfo,
  LinkResponse,
  MeResponse,
  ProviderModelList,
  PutSettingInput,
  RepoList,
  RepoRef,
  ResolvedSettings,
  SettingList,
  SettingView,
  UpdateCredentialInput,
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

  settings: () => request<SettingList>('GET', '/api/settings'),
  putSetting: (input: PutSettingInput) =>
    request<SettingView>('PUT', '/api/settings', { body: input }),
  deleteSetting: (settingId: string) => request<void>('DELETE', `/api/settings/${id(settingId)}`),
  resolveSettings: (repo: RepoRef) =>
    request<ResolvedSettings>('GET', '/api/settings/resolve', { query: { repo: repoKey(repo) } }),

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
