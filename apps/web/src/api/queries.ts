import type {
  ApplyChangesInput,
  AuditRunSummary,
  ClearStorageInput,
  CreateJobInput,
  ForgeWebhookInput,
  LinkAccountInput,
  MediaApplyInput,
  MediaVariantsInput,
  CreateCredentialInput,
  CreateKnowledgeInput,
  ForgeSshKeyInput,
  GroupDocumentData,
  InviteUserInput,
  KnowledgeStatus,
  PutConfigInput,
  PutSettingInput,
  RepoRef,
  UpdateCredentialInput,
  UpdateKnowledgeInput,
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
import { type AiUsageQuery, type AuditLogQuery, type ConfigCollections, api } from './endpoints.ts'

/** Query keys; invalidating a prefix refreshes everything below it. */
export const keys = {
  me: ['me'] as const,
  repos: ['repos'] as const,
  repoUpdates: (repo: RepoRef) => ['repos', 'updates', repoKey(repo)] as const,
  groupListing: (group: string) => ['repos', 'updates', 'group', group] as const,
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
  knowledge: ['knowledge'] as const,
  config: ['config'] as const,
  activity: ['activity'] as const,
  jobs: ['jobs'] as const,
  ai: ['ai'] as const,
  auditLog: ['audit-log'] as const,
  storage: ['storage'] as const,
  accounts: ['accounts'] as const,
  users: ['users'] as const,
  account: ['account'] as const,
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

/** Direct dependencies of every readable repository, joined per library. */
export const useDependencies = (enabled = true) =>
  useQuery({
    queryKey: ['dependencies'],
    queryFn: api.dependencies,
    staleTime: 60_000,
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

export const useCredentials = (enabled = true) =>
  useQuery({ queryKey: keys.credentials, queryFn: api.credentials, enabled })

/** Models an AI provider credential offers, as its API lists them plus the configured ones. */
export const useCredentialModels = (credentialId: string) =>
  useQuery({
    queryKey: [...keys.credentials, credentialId, 'models'],
    queryFn: () => api.credentialModels(credentialId),
    staleTime: 10 * 60_000,
  })

/** Providers of the AI catalog, for `ai-sdk` credentials. */
export const useAiProviders = (enabled = true) =>
  useQuery({
    queryKey: ['ai', 'providers'],
    queryFn: api.aiProviders,
    staleTime: 3_600_000,
    enabled,
  })

/** Models of a catalog provider; idle without one. */
export const useAiProviderModels = (providerId: string | undefined) =>
  useQuery({
    queryKey: ['ai', 'providers', providerId, 'models'],
    queryFn: () => api.aiProviderModels(providerId ?? ''),
    staleTime: 3_600_000,
    enabled: providerId !== undefined,
  })

/** Asks an `ai-sdk` credential's model for a one-word reply. */
export const useTestCredential = () =>
  useMutation({
    mutationFn: ({ id, model }: { id: string; model?: string }) => api.testCredential(id, model),
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

/** How a repository learns about forge changes: polling state and its own webhook. */
export const useRepoUpdates = (repo: RepoRef) =>
  useQuery({
    queryKey: keys.repoUpdates(repo),
    queryFn: () => api.repoUpdates(repoKey(repo)),
    refetchInterval: 30_000,
  })

/** Poll now, issue or rotate the webhook URL, turn it off; each refreshes the view. */
export function useRepoUpdateMutations(repo: RepoRef) {
  const client = useQueryClient()
  const onSuccess = () => client.invalidateQueries({ queryKey: keys.repoUpdates(repo) })
  return {
    poll: useMutation({ mutationFn: () => api.pollRepo(repoKey(repo)), onSuccess }),
    issueWebhook: useMutation({
      mutationFn: (register?: boolean) =>
        api.issueRepoWebhook({
          repo: repoKey(repo),
          ...(register === undefined ? {} : { register }),
        }),
      onSuccess,
    }),
    removeWebhook: useMutation({
      mutationFn: () => api.removeRepoWebhook(repoKey(repo)),
      onSuccess,
    }),
  }
}

/** The repositories polling knows for a group and its recent listings on the forge. */
export const useGroupListing = (group: string, enabled = true) =>
  useQuery({
    queryKey: keys.groupListing(group),
    queryFn: () => api.groupListing(group),
    enabled,
    refetchInterval: 30_000,
  })

/** Lists a group's repositories on its forge now. */
export function useListGroup(group: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => api.listGroup(group),
    onSuccess: (listing) => client.setQueryData(keys.groupListing(group), listing),
  })
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

/** Knowledge entries the caller may read, most recently updated first; `repo` keeps entries covering it. */
export const useKnowledge = (
  query: { status?: readonly KnowledgeStatus[]; repo?: RepoRef },
  enabled = true,
) =>
  useQuery({
    queryKey: [
      ...keys.knowledge,
      (query.status ?? []).join(','),
      query.repo ? repoKey(query.repo) : '*',
    ],
    queryFn: () => api.knowledge(query),
    placeholderData: keepPreviousData,
    enabled,
  })

/** Create, edit, review and delete knowledge entries; each refreshes every knowledge list. */
export function useKnowledgeMutations() {
  const client = useQueryClient()
  const onSuccess = () => client.invalidateQueries({ queryKey: keys.knowledge })
  return {
    create: useMutation({
      mutationFn: (input: CreateKnowledgeInput) => api.createKnowledge(input),
      onSuccess,
    }),
    update: useMutation({
      mutationFn: ({ id, input }: { id: string; input: UpdateKnowledgeInput }) =>
        api.updateKnowledge(id, input),
      onSuccess,
    }),
    review: useMutation({
      mutationFn: ({ id, action }: { id: string; action: 'accept' | 'reject' | 'archive' }) =>
        api.reviewKnowledge(id, action),
      onSuccess,
    }),
    remove: useMutation({ mutationFn: (id: string) => api.deleteKnowledge(id), onSuccess }),
  }
}

/** Forges of the effective config; needs global `settings:read`. */
export const useForges = (enabled = true) =>
  useQuery({ queryKey: [...keys.config, 'forges'], queryFn: api.forges, enabled })

/**
 * Add, change and delete panel forges and issue, rotate or remove their SSH keys; each refreshes
 * the config and the credentials, which hold the forges' tokens and keys.
 */
export function useForgeMutations() {
  const client = useQueryClient()
  const onSuccess = async () => {
    await client.invalidateQueries({ queryKey: keys.config })
    await client.invalidateQueries({ queryKey: keys.credentials })
  }
  return {
    put: useMutation({
      mutationFn: ({ id, data }: { id: string; data: PutConfigInput['forge'] }) =>
        api.putForge(id, data),
      onSuccess,
    }),
    remove: useMutation({ mutationFn: (id: string) => api.deleteForge(id), onSuccess }),
    issueSshKey: useMutation({
      mutationFn: ({ id, input }: { id: string; input: ForgeSshKeyInput }) =>
        api.issueForgeSshKey(id, input),
      onSuccess,
    }),
    removeSshKey: useMutation({ mutationFn: (id: string) => api.removeForgeSshKey(id), onSuccess }),
    issueWebhook: useMutation({
      mutationFn: ({ id, input }: { id: string; input: ForgeWebhookInput }) =>
        api.issueForgeWebhook(id, input),
      onSuccess,
    }),
  }
}

/** Repository groups of the effective config; needs global `settings:read`. */
export const useGroups = (enabled = true) =>
  useQuery({ queryKey: [...keys.config, 'groups'], queryFn: api.groups, enabled })

/** Creates or replaces a group in the panel config; refreshes groups and repositories. */
export function usePutGroup() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: GroupDocumentData }) => api.putGroup(id, data),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: keys.config })
      await client.invalidateQueries({ queryKey: keys.repos })
      await client.invalidateQueries({ queryKey: keys.settings })
    },
  })
}

/** Entries of one config collection with their provenance; needs global `settings:read`. */
export const useConfigEntries = <C extends keyof ConfigCollections>(
  collection: C,
  enabled = true,
) =>
  useQuery({
    queryKey: [...keys.config, collection],
    queryFn: () => api.configEntries(collection),
    enabled,
  })

/** One config entry and the earlier versions of its panel document. */
export const useConfigEntry = <C extends keyof ConfigCollections>(
  collection: C,
  entryId: string | undefined,
) =>
  useQuery({
    queryKey: [...keys.config, collection, 'detail', entryId ?? ''],
    queryFn: () => api.configEntry(collection, entryId ?? ''),
    enabled: entryId !== undefined,
  })

/**
 * Create, replace and remove panel documents of a collection; each refreshes the config,
 * repositories and settings, which all depend on it.
 */
export function useConfigMutations<C extends keyof ConfigCollections>(collection: C) {
  const client = useQueryClient()
  const onSuccess = async () => {
    await client.invalidateQueries({ queryKey: keys.config })
    await client.invalidateQueries({ queryKey: keys.repos })
    await client.invalidateQueries({ queryKey: ['explain'] })
  }
  return {
    put: useMutation({
      mutationFn: ({ id, data }: { id: string; data: PutConfigInput[ConfigCollections[C]] }) =>
        api.putConfigEntry(collection, id, data),
      onSuccess,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api.deleteConfigEntry(collection, id),
      onSuccess,
    }),
  }
}

/** Upcoming run times of a schedule of the effective config. */
export const useSchedulePreview = (scheduleId: string | undefined, count = 10) =>
  useQuery({
    queryKey: [...keys.config, 'schedules', 'preview', scheduleId ?? '', count],
    queryFn: () => api.schedulePreview(scheduleId ?? '', count),
    enabled: scheduleId !== undefined,
  })

/** The file-only parts of the config: execution, storage, limits, plugins. */
export const useRuntimeConfig = (enabled = true) =>
  useQuery({ queryKey: [...keys.config, 'runtime'], queryFn: api.runtimeConfig, enabled })

/**
 * A counter bumped after the avatar of `repo` changed, so `<img>`s showing it reload; 0 until then.
 * Lives only in the query cache.
 */
export const useRepoAvatarVersion = (repo: RepoRef) =>
  useQuery({
    queryKey: ['repo-avatar', 'version', repoKey(repo)],
    queryFn: () => 0,
    staleTime: Infinity,
    gcTime: Infinity,
  }).data ?? 0

/** Where a repository's avatar comes from: uploaded, the forge's, or generated. */
export const useRepoAvatarInfo = (repo: RepoRef) =>
  useQuery({
    queryKey: ['repo-avatar', 'info', repoKey(repo)],
    queryFn: () => api.repoAvatarInfo(repo),
  })

/** Upload or reset a repository's own avatar; reloads every image of it. */
export function useRepoAvatarMutations(repo: RepoRef) {
  const client = useQueryClient()
  const onSuccess = () => {
    client.setQueryData<number>(['repo-avatar', 'version', repoKey(repo)], (v = 0) => v + 1)
    void client.invalidateQueries({ queryKey: ['repo-avatar', 'info', repoKey(repo)] })
  }
  return {
    upload: useMutation({ mutationFn: (file: Blob) => api.setRepoAvatar(repo, file), onSuccess }),
    reset: useMutation({ mutationFn: () => api.removeRepoAvatar(repo), onSuccess }),
  }
}

/** What the config applies to a repository: groups, traits, plugins, schedules and triggers. */
export const useExplainRepo = (repo: RepoRef) =>
  useQuery({ queryKey: ['explain', repoKey(repo)], queryFn: () => api.explainRepo(repo) })

/** Analyzers jobs can run, with their option schemas; `enabled` is false without jobs. */
export const useJobAnalyzers = () =>
  useQuery({
    queryKey: [...keys.jobs, 'analyzers'],
    queryFn: api.jobAnalyzers,
    staleTime: Infinity,
  })

const activeStatus = (status: string) => status === 'queued' || status === 'running'

/** Jobs, newest first; refreshes every few seconds while some are queued or running. */
export const useJobs = (
  filter: { status?: string; repo?: RepoRef; schedule?: string; limit?: number } = {},
) =>
  useQuery({
    queryKey: [
      ...keys.jobs,
      'list',
      filter.status ?? '',
      filter.repo ? repoKey(filter.repo) : '*',
      filter.schedule ?? '*',
      filter.limit ?? 100,
    ],
    queryFn: () => api.jobs({ limit: 100, ...filter }),
    placeholderData: keepPreviousData,
    refetchInterval: (query) =>
      query.state.data?.jobs.some((job) => activeStatus(job.status)) ? 3_000 : 30_000,
  })

/** Recent runs of every schedule; refreshes every few seconds while a run is unfinished. */
export const useScheduleRuns = () =>
  useQuery({
    queryKey: [...keys.jobs, 'schedule-runs'],
    queryFn: () => api.scheduleRuns(),
    refetchInterval: (query) =>
      query.state.data?.schedules.some((s) => s.runs.some((run) => run.queued + run.running > 0))
        ? 4_000
        : 30_000,
  })

/** Queues every job of a schedule now; refreshes job lists and schedule runs. */
export function useRunSchedule() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (scheduleId: string) => api.runSchedule(scheduleId),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.jobs }),
  })
}

/** One job with its log; refreshes while it is queued or running. */
export const useJob = (jobId: string | undefined) =>
  useQuery({
    queryKey: [...keys.jobs, 'detail', jobId ?? ''],
    queryFn: () => api.job(jobId ?? ''),
    enabled: jobId !== undefined,
    refetchInterval: (query) =>
      query.state.data && activeStatus(query.state.data.status) ? 2_000 : false,
  })

/** Queue and cancel jobs; each refreshes every job list. */
export function useJobMutations() {
  const client = useQueryClient()
  const onSuccess = () => client.invalidateQueries({ queryKey: keys.jobs })
  return {
    create: useMutation({ mutationFn: (input: CreateJobInput) => api.createJob(input), onSuccess }),
    cancel: useMutation({ mutationFn: (id: string) => api.cancelJob(id), onSuccess }),
  }
}

/** This month's AI usage at a glance; needs `ai:read`. */
export const useAiOverview = (enabled = true) =>
  useQuery({ queryKey: [...keys.ai, 'overview'], queryFn: api.aiOverview, enabled })

/** AI usage sums grouped by `groupBy` (comma list of dimensions). */
export const useAiUsage = (filter: AiUsageQuery & { groupBy?: string }) =>
  useQuery({
    queryKey: [...keys.ai, 'usage', filter],
    queryFn: () => api.aiUsage(filter),
    placeholderData: keepPreviousData,
  })

/** Individual AI runs, newest first, paged by time. */
export function useAiRuns(filter: AiUsageQuery, pageSize = 50) {
  return useInfiniteQuery({
    queryKey: [...keys.ai, 'runs', filter],
    queryFn: ({ pageParam }) =>
      api.aiRuns({ ...filter, limit: pageSize, ...(pageParam ? { before: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next,
  })
}

/** Audit log events, newest first, paged by cursor; needs global `audit:read`. */
export function useAuditLog(filter: AuditLogQuery, pageSize = 50) {
  return useInfiniteQuery({
    queryKey: [...keys.auditLog, 'list', filter],
    queryFn: ({ pageParam }) =>
      api.auditLog({ ...filter, limit: pageSize, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
  })
}

/** How many audit log events match the filter. */
export const useAuditLogCount = (filter: AuditLogQuery) =>
  useQuery({
    queryKey: [...keys.auditLog, 'count', filter],
    queryFn: () => api.auditLogCount(filter),
    placeholderData: keepPreviousData,
  })

/** Checks the audit log's hash chain. */
export const useVerifyAuditLog = () =>
  useMutation({
    mutationFn: (range: { fromSeq?: number; toSeq?: number } = {}) => api.verifyAuditLog(range),
  })

/** Space used by the store, artifacts, caches and checkouts; needs global `settings:read`. */
export const useStorage = (enabled = true) =>
  useQuery({ queryKey: keys.storage, queryFn: api.storage, enabled })

/** Clears one storage area; refreshes the overview. */
export function useClearStorage() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input?: ClearStorageInput }) =>
      api.clearStorage(id, input),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.storage }),
  })
}

/** External accounts (GitLab, GitHub, Slack, ...) linked to the signed-in principal. */
export const useAccounts = (enabled = true) =>
  useQuery({ queryKey: keys.accounts, queryFn: api.accounts, enabled, retry: false })

/** Link, unlink and verify external accounts; each refreshes the list. */
export function useAccountMutations() {
  const client = useQueryClient()
  const onSuccess = () => client.invalidateQueries({ queryKey: keys.accounts })
  return {
    link: useMutation({
      mutationFn: (input: LinkAccountInput) => api.linkAccount(input),
      onSuccess,
    }),
    unlink: useMutation({ mutationFn: (id: string) => api.unlinkAccount(id), onSuccess }),
    challenge: useMutation({ mutationFn: (id: string) => api.accountChallenge(id), onSuccess }),
  }
}

/** Generates image variants and puts the chosen ones into a merge request or a ZIP download. */
export function useMediaMutations() {
  return {
    variants: useMutation({ mutationFn: (input: MediaVariantsInput) => api.mediaVariants(input) }),
    apply: useMutation({
      mutationFn: (input: MediaApplyInput & { mode: 'merge-request' }) => api.applyMedia(input),
    }),
    zip: useMutation({
      mutationFn: (input: MediaApplyInput & { mode: 'zip' }) => api.mediaZip(input),
    }),
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

/** The signed-in user's own account, with the `users` provider only. */
export const useAccount = () => useQuery({ queryKey: keys.account, queryFn: api.account })

/** Rerolls the signed-in user's avatar; `null` goes back to the default. */
export function useSetAvatar() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (seed: string | null) => api.setAvatar(seed),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: keys.me })
      await client.invalidateQueries({ queryKey: keys.account })
      await client.invalidateQueries({ queryKey: keys.users })
      await client.invalidateQueries({ queryKey: keys.activity })
    },
  })
}

/** Adding, renaming and removing the signed-in user's own passkeys. */
export function useAccountPasskeys() {
  const client = useQueryClient()
  const onSuccess = async () => {
    await client.invalidateQueries({ queryKey: keys.account })
    await client.invalidateQueries({ queryKey: keys.users })
  }
  return {
    add: useMutation({
      mutationFn: async (label: string) => {
        const optionsJSON = await api.addPasskeyOptions()
        const response = await startRegistration({ optionsJSON })
        return api.addPasskeyVerify(response, label.trim() || undefined)
      },
      onSuccess,
    }),
    rename: useMutation({
      mutationFn: ({ id, label }: { id: string; label: string }) => api.renameOwnPasskey(id, label),
      onSuccess,
    }),
    remove: useMutation({ mutationFn: (id: string) => api.removeOwnPasskey(id), onSuccess }),
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
