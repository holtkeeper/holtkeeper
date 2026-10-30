import type {
  ApplyChangesInput,
  AuditRunSummary,
  CreateCredentialInput,
  InviteUserInput,
  PutSettingInput,
  RepoRef,
  UpdateCredentialInput,
  UpdateUserInput,
} from '@holtkeeper/api'
import { startAuthentication, startRegistration } from '@simplewebauthn/browser'
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'

import { repoKey } from '../lib/repo.ts'
import { api } from './endpoints.ts'

/** Query keys; invalidating a prefix refreshes everything below it. */
export const keys = {
  me: ['me'] as const,
  repos: ['repos'] as const,
  auditRuns: (repo?: RepoRef, limit?: number) =>
    ['audit-runs', 'list', repo ? repoKey(repo) : '*', limit ?? 0] as const,
  auditRun: (runId: string) => ['audit-runs', 'detail', runId] as const,
  analyses: (kind: string, repo?: RepoRef) =>
    ['analyses', 'list', kind, repo ? repoKey(repo) : '*'] as const,
  analysis: (analysisId: string, compare?: string) =>
    ['analyses', 'detail', analysisId, compare ?? ''] as const,
  credentials: ['credentials'] as const,
  settings: ['settings'] as const,
  resolved: (repo: RepoRef) => ['settings', 'resolve', repoKey(repo)] as const,
  activity: ['activity'] as const,
  users: ['users'] as const,
  link: (token: string) => ['link', token] as const,
}

/** The signed-in principal and the login methods. */
export const useMe = () =>
  useQuery({ queryKey: keys.me, queryFn: ({ signal }) => api.me(signal), staleTime: 60_000 })

export const useRepos = (enabled = true) =>
  useQuery({ queryKey: keys.repos, queryFn: api.repos, enabled })

/** Audit run summaries, newest first; all repositories when `repo` is omitted. */
export const useAuditRuns = (repo?: RepoRef, limit = 100, enabled = true) =>
  useQuery({
    queryKey: keys.auditRuns(repo, limit),
    queryFn: () => api.auditRuns({ ...(repo ? { repo } : {}), limit }),
    placeholderData: keepPreviousData,
    enabled,
  })

export const useAuditRun = (runId: string) =>
  useQuery({
    queryKey: keys.auditRun(runId),
    queryFn: () => api.auditRun(runId),
    staleTime: Infinity,
  })

/** Full details of several runs at once (runs never change once stored). */
export function useAuditRunDetails(runs: readonly AuditRunSummary[]) {
  return useQueries({
    queries: runs.map((run) => ({
      queryKey: keys.auditRun(run.id),
      queryFn: () => api.auditRun(run.id),
      staleTime: Infinity,
    })),
  })
}

/** Analysis kinds the server understands. */
export const useAnalysisKinds = () =>
  useQuery({ queryKey: ['analyses', 'kinds'], queryFn: api.analysisKinds, staleTime: Infinity })

/** Analysis records of one kind, newest first; all repositories when `repo` is omitted. */
export const useAnalyses = (kind: string, repo?: RepoRef, limit = 100, enabled = true) =>
  useQuery({
    queryKey: [...keys.analyses(kind, repo), limit],
    queryFn: () => api.analyses({ kind, limit, ...(repo ? { repo } : {}) }),
    placeholderData: keepPreviousData,
    enabled,
  })

/** A rendered report, compared with `compare` or, by default, the previous record. */
export const useAnalysis = (analysisId: string, compare?: string) =>
  useQuery({
    queryKey: keys.analysis(analysisId, compare),
    queryFn: () => api.analysis(analysisId, compare),
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
  })

/** Accepts proposed changes of an analysis as a patch or a merge request. */
export const useApplyChanges = (analysisId: string) =>
  useMutation({ mutationFn: (input: ApplyChangesInput) => api.applyChanges(analysisId, input) })

export const useCredentials = () =>
  useQuery({ queryKey: keys.credentials, queryFn: api.credentials })

/** Models an AI provider credential offers, as its API lists them plus the configured ones. */
export const useCredentialModels = (credentialId: string) =>
  useQuery({
    queryKey: [...keys.credentials, credentialId, 'models'],
    queryFn: () => api.credentialModels(credentialId),
    staleTime: 10 * 60_000,
  })

/** Create, update, rotate and delete credentials; each refreshes the list. */
export function useCredentialMutations() {
  const client = useQueryClient()
  const onSuccess = () => client.invalidateQueries({ queryKey: keys.credentials })
  return {
    create: useMutation({
      mutationFn: (input: CreateCredentialInput) => api.createCredential(input),
      onSuccess,
    }),
    update: useMutation({
      mutationFn: ({ id, input }: { id: string; input: UpdateCredentialInput }) =>
        api.updateCredential(id, input),
      onSuccess,
    }),
    rotate: useMutation({ mutationFn: (id: string) => api.rotateCredential(id), onSuccess }),
    remove: useMutation({ mutationFn: (id: string) => api.deleteCredential(id), onSuccess }),
  }
}

export const useSettings = () => useQuery({ queryKey: keys.settings, queryFn: api.settings })

export const useResolvedSettings = (repo: RepoRef | undefined) =>
  useQuery({
    queryKey: repo ? keys.resolved(repo) : ['settings', 'resolve', 'none'],
    queryFn: () => api.resolveSettings(repo!),
    enabled: repo !== undefined,
  })

export function useSettingMutations() {
  const client = useQueryClient()
  const onSuccess = () => client.invalidateQueries({ queryKey: keys.settings })
  return {
    put: useMutation({ mutationFn: (input: PutSettingInput) => api.putSetting(input), onSuccess }),
    remove: useMutation({ mutationFn: (id: string) => api.deleteSetting(id), onSuccess }),
  }
}

/** Activity events, newest first, paged by the oldest event's time. */
export function useActivity(pageSize = 50) {
  return useInfiniteQuery({
    queryKey: keys.activity,
    queryFn: ({ pageParam }) =>
      api.activity({ limit: pageSize, ...(pageParam ? { before: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) =>
      last.events.length < pageSize ? undefined : last.events.at(-1)?.at,
  })
}

export const useUsers = (enabled = true) =>
  useQuery({ queryKey: keys.users, queryFn: api.users, enabled })

export function useUserMutations() {
  const client = useQueryClient()
  const onSuccess = () => client.invalidateQueries({ queryKey: keys.users })
  return {
    invite: useMutation({
      mutationFn: (input: InviteUserInput) => api.inviteUser(input),
      onSuccess,
    }),
    update: useMutation({
      mutationFn: ({ id, input }: { id: string; input: UpdateUserInput }) =>
        api.updateUser(id, input),
      onSuccess,
    }),
    recovery: useMutation({ mutationFn: (id: string) => api.recoveryLink(id), onSuccess }),
    removePasskey: useMutation({
      mutationFn: ({ userId, passkeyId }: { userId: string; passkeyId: string }) =>
        api.deletePasskey(userId, passkeyId),
      onSuccess,
    }),
  }
}

/** Sign-in and sign-out; every one of them refreshes `useMe` and drops cached data. */
export function useAuthMutations() {
  const client = useQueryClient()
  const onSuccess = async () => {
    client.removeQueries({ predicate: (query) => query.queryKey[0] !== keys.me[0] })
    await client.invalidateQueries({ queryKey: keys.me })
  }
  return {
    password: useMutation({
      mutationFn: (password: string) => api.passwordLogin(password),
      onSuccess,
    }),
    passkey: useMutation({
      mutationFn: async () => {
        const optionsJSON = await api.passkeyLoginOptions()
        await api.passkeyLoginVerify(await startAuthentication({ optionsJSON }))
      },
      onSuccess,
    }),
    logout: useMutation({ mutationFn: (url: string) => api.logout(url), onSuccess }),
  }
}

export const useLinkInfo = (token: string) =>
  useQuery({ queryKey: keys.link(token), queryFn: () => api.linkInfo(token), retry: false })

/** Registers a passkey through a setup or recovery link, which also signs the user in. */
export function useRegisterPasskey(token: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async (label: string) => {
      const optionsJSON = await api.linkRegisterOptions(token)
      const response = await startRegistration({ optionsJSON })
      await api.linkRegisterVerify(token, response, label.trim() || undefined)
    },
    onSuccess: () => client.invalidateQueries({ queryKey: keys.me }),
  })
}
