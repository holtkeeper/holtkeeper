import type {
  AcceptLearningInput,
  AcceptLearningsInput,
  AllowlistRenewInput,
  AssetsQuery,
  CiFleetJobSort,
  InboxItem,
  AgentTaskStatus,
  EditLearningInput,
  FamilyInput,
  GuideScopeKey,
  GuideSectionName,
  GuideSectionRejectInput,
  GuideTask,
  LearningStatus,
  PutGuideSectionInput,
  RegenerateGuideInput,
  AnalysisBackfillInput,
  ChatMessageList,
  ChatPostInput,
  ChatThreadPatchInput,
  SlackSettingsView,
  DeployState,
  ReleaseAcceptInput,
  ReleaseDeployInput,
  ReleaseEditsInput,
  ReleaseRepoView,
  ReleaseStepInput,
  ReleaseSummaryInput,
  ApplyChangesInput,
  ClearStorageInput,
  DatabaseQuerySort,
  DeleteEgressCacheInput,
  CreateMcpTokenInput,
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
  ReviewQuery,
  Scope,
  UpdateCredentialInput,
  UpdateKnowledgeInput,
  UpdateUserInput,
  UserPreferencesInput,
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
import { useCallback, useMemo } from 'react'

import { hasLiveCards, mergeMessages, withNewer, withOlder } from '../lib/chat.ts'
import { type GroupTitleOf, groupTitleOf } from '../lib/group-titles.ts'
import { runBulk } from '../lib/inbox.ts'
import { browserStorage, clearRecent } from '../lib/palette.ts'
import { repoKey } from '../lib/repo.ts'
import { type ScopeFocus, describeScope } from '../lib/scope.ts'
import {
  type AiOverviewQuery,
  type AiUsageQuery,
  type ConfigCollections,
  type HistoryQuery,
  type JobQuery,
  type PublicApiSearchQuery,
  type PublicApiSymbolQuery,
  api,
} from './endpoints.ts'

/** Query keys; invalidating a prefix refreshes everything below it. */
export const keys = {
  me: ['me'] as const,
  preferences: ['me', 'preferences'] as const,
  home: ['home'] as const,
  inbox: ['inbox'] as const,
  inboxCount: ['inbox', 'count'] as const,
  repos: ['repos'] as const,
  repoUpdates: (repo: RepoRef) => ['repos', 'updates', repoKey(repo)] as const,
  groupListing: (group: string) => ['repos', 'updates', 'group', group] as const,
  auditRuns: (repo?: RepoRef, limit?: number) =>
    ['audit-runs', 'list', repo ? repoKey(repo) : '*', limit ?? 0] as const,
  auditRun: (runId: string) => ['audit-runs', 'detail', runId] as const,
  findings: (repo?: RepoRef) => ['audit-runs', 'findings', repo ? repoKey(repo) : '*'] as const,
  licenses: ['licenses'] as const,
  analyses: (kind: string, repo?: RepoRef) =>
    ['analyses', 'list', kind, repo ? repoKey(repo) : '*'] as const,
  analysis: (analysisId: string, compare?: string) =>
    ['analyses', 'detail', analysisId, compare ?? ''] as const,
  credentials: ['credentials'] as const,
  settings: ['settings'] as const,
  resolved: (focus: ScopeFocus) =>
    [
      'settings',
      'resolve',
      focus.kind === 'repo' ? repoKey(focus.repo) : `group:${focus.group}`,
    ] as const,
  knowledge: ['knowledge'] as const,
  knowledgeCounts: ['knowledge', 'counts'] as const,
  guide: ['guide'] as const,
  guideScope: (scope: GuideScopeKey) => ['guide', 'scope', scope] as const,
  guideSection: (scope: GuideScopeKey, section: GuideSectionName) =>
    ['guide', 'section', scope, section] as const,
  guidePreview: (repo: RepoRef, task: GuideTask) =>
    ['guide', 'preview', repoKey(repo), task] as const,
  guideChain: (repo: RepoRef, section?: GuideSectionName) =>
    ['guide', 'chain', repoKey(repo), section ?? '*'] as const,
  guideRepoFiles: (repo: RepoRef) => ['guide', 'repo-files', repoKey(repo)] as const,
  guideGeneratedHistory: (scope: GuideScopeKey, section: GuideSectionName) =>
    ['guide', 'generated', scope, section] as const,
  families: ['families'] as const,
  learnings: ['learnings'] as const,
  config: ['config'] as const,
  jobs: ['jobs'] as const,
  ai: ['ai'] as const,
  history: ['history'] as const,
  storage: ['storage'] as const,
  database: ['database'] as const,
  egressCache: ['egress-cache'] as const,
  libraries: ['libraries'] as const,
  accounts: ['accounts'] as const,
  chat: ['chat'] as const,
  chatContext: (threadId: string) => ['chat', 'context', threadId] as const,
  slack: ['slack'] as const,
  users: ['users'] as const,
  account: ['account'] as const,
  link: (token: string) => ['link', token] as const,
  releases: ['releases'] as const,
  releaseOverview: ['releases', 'overview'] as const,
  releaseTimeline: (repo: RepoRef) => ['releases', 'timeline', repoKey(repo)] as const,
  releaseVersion: (repo: RepoRef, tag: string) =>
    ['releases', 'version', repoKey(repo), tag] as const,
  releaseRepo: (repo: RepoRef) => ['releases', 'repo', repoKey(repo)] as const,
  releaseDetect: (repo: RepoRef) => ['release-detect', repoKey(repo)] as const,
  releaseDeploy: (repo: RepoRef, tag: string) =>
    ['releases', 'deploy', repoKey(repo), tag] as const,
}

/** The signed-in principal and the login methods. */
export const useMe = () =>
  useQuery({ queryKey: keys.me, queryFn: ({ signal }) => api.me(signal), staleTime: 60_000 })

/** What people see for each group key (its display title, else the key), from `useMe`. */
export function useGroupTitles(): GroupTitleOf {
  const titles = useMe().data?.groupTitles
  return useMemo(() => groupTitleOf(titles), [titles])
}

/** `describeScope` with groups shown by their display titles. */
export function useDescribeScope(): (scope: Scope) => string {
  const titleOf = useGroupTitles()
  return useCallback((scope: Scope) => describeScope(scope, titleOf), [titleOf])
}

/** The Home page in one read; refreshed every minute while it is open. */
export const useHome = () =>
  useQuery({ queryKey: keys.home, queryFn: api.home, refetchInterval: 60_000 })

/** Inbox and Home, which list decisions; every decision refreshes both. */
const decisionKeys = [keys.inbox, keys.home] as const

const refreshDecisions = (client: ReturnType<typeof useQueryClient>) =>
  Promise.all(decisionKeys.map((queryKey) => client.invalidateQueries({ queryKey })))

/** Every decision the caller may make, both sections, snoozed ones marked. */
export const useInbox = () =>
  useQuery({ queryKey: [...keys.inbox, 'feed'], queryFn: api.inbox, refetchInterval: 60_000 })

/** Open decisions per section, for badges; read at most every 30 seconds. */
export const useInboxCount = (enabled = true) =>
  useQuery({
    queryKey: keys.inboxCount,
    queryFn: api.inboxCount,
    enabled,
    staleTime: 30_000,
    refetchInterval: 60_000,
  })

/** Snooze and unsnooze Inbox and Home items; each refreshes Inbox and Home. */
export function useSnoozeMutations() {
  const client = useQueryClient()
  const onSuccess = () => refreshDecisions(client)
  return {
    snooze: useMutation({
      mutationFn: ({ id, until }: { id: string; until: string }) => api.snooze({ id, until }),
      onSuccess,
    }),
    unsnooze: useMutation({ mutationFn: (id: string) => api.unsnooze(id), onSuccess }),
  }
}

/** A decision on an Inbox item: the positive one (approve, accept, renew) or reject. */
export type InboxDecision = 'approve' | 'reject'

/**
 * Optional parts of a decision: the learning scope (else its `targetScope`, else where
 * `suggestedScope` points), the renewal date and a reason that replaces the allowlist entry's.
 */
export interface InboxDecisionOptions {
  scope?: GuideScopeKey
  expires?: string
  reason?: string
}

/** Sends one Inbox decision to its kind's endpoint; a task reject goes to the reject endpoint, audited as `task.reject`. */
export function decideInbox(
  item: InboxItem,
  decision: InboxDecision,
  options: InboxDecisionOptions = {},
): Promise<unknown> {
  const approve = decision === 'approve'
  switch (item.kind) {
    case 'task':
      return approve ? api.approveTaskGroup(item.groupId) : api.rejectTaskGroup(item.groupId)
    case 'note':
      return api.reviewKnowledge(item.entryId, approve ? 'accept' : 'reject')
    case 'learning':
      return approve
        ? api.acceptLearning(item.learningId, options.scope ? { scope: options.scope } : {})
        : api.rejectLearning(item.learningId)
    case 'guide':
      return approve
        ? api.acceptGuideSection(item.guideScope, item.section, { inputHash: item.inputHash })
        : api.rejectGuideSection({
            scope: item.guideScope,
            section: item.section,
            inputHash: item.inputHash,
          })
    case 'release':
      return approve
        ? api.acceptRelease({ repo: item.repo })
        : api.dismissRelease({ repo: item.repo, sha: item.head })
    case 'budget':
      return Promise.reject(new Error('a budget warning has nothing to decide'))
    default: {
      if (!approve) return Promise.reject(new Error('an allowlist entry can only be renewed'))
      if (!options.expires) return Promise.reject(new Error('choose the new last day'))
      const input: AllowlistRenewInput = {
        settingId: item.settingId,
        advisory: item.entry.id,
        expires: options.expires,
        ...(item.entry.package ? { package: item.entry.package } : {}),
        ...(options.reason?.trim() ? { reason: options.reason.trim() } : {}),
      }
      return api.renewAllowlist(input)
    }
  }
}

const areaKeys: Record<InboxItem['kind'], readonly (readonly string[])[]> = {
  task: [['tasks'], ['chat', 'poll']],
  note: [keys.knowledge],
  learning: [keys.learnings, keys.guide, keys.knowledgeCounts],
  guide: [keys.guide, keys.knowledgeCounts],
  release: [keys.releases],
  allowlist: [keys.settings, ['audit-runs']],
  budget: [keys.ai],
}

/** Query keys a decision on items of `kinds` refreshes: Inbox, Home, then each kind's own area. */
export const decisionQueryKeys = (kinds: readonly InboxItem['kind'][]): (readonly string[])[] => {
  const all = [...decisionKeys, ...[...new Set(kinds)].flatMap((kind) => areaKeys[kind])]
  return all.filter((key, index) => all.findIndex((k) => k.join('\0') === key.join('\0')) === index)
}

/**
 * Decisions on Inbox items, one at a time or in bulk. Bulk runs the rows one after another on
 * the client and reports errors per row. Every decision refreshes Inbox, Home and the queries of
 * the item's own area (tasks, knowledge, learnings, Guide, releases, settings).
 */
export function useInboxDecisions() {
  const client = useQueryClient()
  const refresh = (kinds: readonly InboxItem['kind'][]) =>
    Promise.all(decisionQueryKeys(kinds).map((queryKey) => client.invalidateQueries({ queryKey })))
  return {
    decide: useMutation({
      mutationFn: ({
        item,
        decision,
        ...options
      }: { item: InboxItem; decision: InboxDecision } & InboxDecisionOptions) =>
        decideInbox(item, decision, options),
      onSuccess: (_data, { item }) => refresh([item.kind]),
    }),
    bulk: useMutation({
      mutationFn: ({
        items,
        decision,
        options,
      }: {
        items: readonly InboxItem[]
        decision: InboxDecision
        options?: (item: InboxItem) => InboxDecisionOptions
      }) => runBulk(items, (item) => decideInbox(item, decision, options?.(item))),
      onSettled: (_data, _error, { items }) => refresh(items.map((item) => item.kind)),
    }),
    snoozeMany: useMutation({
      mutationFn: ({ items, until }: { items: readonly InboxItem[]; until: string }) =>
        runBulk(items, (item) => api.snooze({ id: item.id, until })),
      onSettled: () => refreshDecisions(client),
    }),
  }
}

/**
 * Retry of a Home job-failure item: queues `analyzer` again on each of `repos` (`forge:path`).
 * Refreshes jobs, Home and Inbox.
 */
export function useRetryAttention() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ analyzer, repos }: { analyzer: string; repos: readonly string[] }) =>
      Promise.all(repos.map((repo) => api.createJob({ analyzer, repo }))),
    onSuccess: () =>
      Promise.all([client.invalidateQueries({ queryKey: keys.jobs }), refreshDecisions(client)]),
  })
}

export const useRepos = (enabled = true) =>
  useQuery({ queryKey: keys.repos, queryFn: api.repos, enabled })

/** Groups of the repositories the viewer can see, sorted, for scope suggestions. */
export function useGroupNames(enabled = true): string[] {
  const repos = useRepos(enabled)
  return [...new Set((repos.data?.repos ?? []).flatMap((repo) => repo.groups))].toSorted()
}

/** Audit run summaries, newest first; all repositories when `repo` is omitted. */
export const useAuditRuns = (repo?: RepoRef, limit = 100, enabled = true) =>
  useQuery({
    queryKey: keys.auditRuns(repo, limit),
    queryFn: () => api.auditRuns({ ...(repo ? { repo } : {}), limit }),
    placeholderData: keepPreviousData,
    enabled,
  })

/** Each audit run's detail, in order; one query per run id. */
export const useAuditRunDetails = (runIds: readonly string[]) =>
  useQueries({
    queries: runIds.map((runId) => ({
      queryKey: keys.auditRun(runId),
      queryFn: () => api.auditRun(runId),
      staleTime: Infinity,
    })),
  })

export const useAuditRun = (runId: string) =>
  useQuery({
    queryKey: keys.auditRun(runId),
    queryFn: () => api.auditRun(runId),
    staleTime: Infinity,
  })

/** Open, fixing and allowlisted findings grouped by advisory and package; all repositories when `repo` is omitted. */
export const useFindings = (repo?: RepoRef, enabled = true) =>
  useQuery({
    queryKey: keys.findings(repo),
    queryFn: () => api.findings(repo),
    placeholderData: keepPreviousData,
    enabled,
    staleTime: 60_000,
  })

/** Fleet license overview: KPIs, license mix, violations, per-repository rows and the policy. */
export const useLicenses = (enabled = true) =>
  useQuery({ queryKey: keys.licenses, queryFn: api.licenses, enabled, staleTime: 60_000 })

/** Analysis records of one kind, newest first; all repositories when `repo` is omitted. */
export const useAnalyses = (kind: string, repo?: RepoRef, limit = 100, enabled = true) =>
  useQuery({
    queryKey: [...keys.analyses(kind, repo), limit],
    queryFn: () => api.analyses({ kind, limit, ...(repo ? { repo } : {}) }),
    placeholderData: keepPreviousData,
    enabled,
  })

/** Repositories with CI runs in the last 30 days, one card each, from their newest `ci-jobs` record. */
export const useCiOverview = () =>
  useQuery({ queryKey: ['ci', 'overview'], queryFn: api.ciOverview, staleTime: 60_000 })

/** One repository's CI jobs as table rows, at most `limit` (server default when absent); disabled without a repository. */
export const useCiJobs = (repo: RepoRef | undefined, limit?: number) =>
  useQuery({
    queryKey: ['ci', 'jobs', repo ? repoKey(repo) : 'none', limit ?? 0],
    queryFn: () => api.ciJobs(repo!, limit),
    enabled: repo !== undefined,
    staleTime: 60_000,
  })

/** The worst CI jobs across every readable repository, ranked by `sort`. */
export const useCiFleetJobs = (sort: CiFleetJobSort, limit?: number) =>
  useQuery({
    queryKey: ['ci', 'fleet-jobs', sort, limit ?? 0],
    queryFn: () => api.ciFleetJobs(sort, limit),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  })

/** One repository's newest `ci-jobs` record with its problem jobs. */
export const useCiRepo = (repo: RepoRef | undefined) =>
  useQuery({
    queryKey: ['ci', 'repo', repo ? repoKey(repo) : 'none'],
    queryFn: () => api.ciRepo(repo!),
    enabled: repo !== undefined,
    staleTime: 60_000,
  })

/** Coverage cards of every readable repository with a coverage record. */
export const useCoverageOverview = () =>
  useQuery({
    queryKey: ['coverage', 'overview'],
    queryFn: () => api.coverageOverview(),
    staleTime: 60_000,
  })

/** One repository's coverage card with its breakdown; disabled without a repository. */
export const useRepoCoverage = (repo: RepoRef | undefined) =>
  useQuery({
    queryKey: ['coverage', 'repo', repo ? repoKey(repo) : 'none'],
    queryFn: () => api.repoCoverage(repo!),
    enabled: repo !== undefined,
    staleTime: 60_000,
  })

/**
 * The fleet Assets table under `query`'s filters and sort, one page per `limit` (server default
 * when absent); further pages continue from the previous page's `nextCursor`.
 */
export const useAssets = (query: Omit<AssetsQuery, 'cursor'> = {}, enabled = true) =>
  useInfiniteQuery({
    queryKey: ['assets', 'list', query],
    queryFn: ({ pageParam }) =>
      api.assets({ ...query, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    enabled,
  })

/** Bundle targets of every readable repository with a bundle record, from stored metrics. */
export const useBundlesOverview = () =>
  useQuery({ queryKey: ['bundles', 'overview'], queryFn: api.bundles, staleTime: 60_000 })

/** Branches worth deleting in every readable repository with a branches record. */
export const useBranchesOverview = () =>
  useQuery({ queryKey: ['branches', 'overview'], queryFn: api.branches, staleTime: 60_000 })

/** A repository's effective asset policy and its newest assets record. */
export const useRepoAssets = (repo: RepoRef) =>
  useQuery({
    queryKey: ['assets', 'repo', repoKey(repo)],
    queryFn: () => api.repoAssets(repo),
    staleTime: 60_000,
  })

/** Direct dependencies of every readable repository, joined per library. */
export const useDependencies = () =>
  useQuery({ queryKey: ['dependencies'], queryFn: api.dependencies, staleTime: 60_000 })

/** Libraries whose name contains `q`, best first; idle while `q` is empty. */
export const useDependencySearch = (q: string) =>
  useQuery({
    queryKey: ['dependencies', 'search', q],
    queryFn: () => api.dependencySearch(q, 10),
    placeholderData: keepPreviousData,
    enabled: q.trim().length > 0,
    staleTime: 30_000,
  })

/** The newest stack record of every readable group: runtimes, end of life and conventions. */
export const useStack = () =>
  useQuery({ queryKey: ['stack'], queryFn: api.stack, staleTime: 60_000 })

/** One library: who uses it, advisories, licenses, decisions, update MRs and its documents. */
export const useDependency = (library: { ecosystem: string; name: string } | undefined) =>
  useQuery({
    queryKey: ['dependencies', 'library', library?.ecosystem ?? '', library?.name ?? ''],
    queryFn: () => api.dependency(library!.ecosystem, library!.name),
    enabled: library !== undefined,
    staleTime: 60_000,
  })

/** Where a library's API is recorded, with export totals and entry points; idle until `enabled`. */
export const useDependencyApi = (
  library: { ecosystem: string; name: string } | undefined,
  enabled = true,
) =>
  useQuery({
    queryKey: ['dependencies', 'api', library?.ecosystem ?? '', library?.name ?? ''],
    queryFn: () => api.dependencyApi(library!.ecosystem, library!.name),
    enabled: enabled && library !== undefined,
    staleTime: 60_000,
  })

/** Changelog, API changes and affected uses of upgrading a library between two versions. */
export const useDependencyUpgrade = (
  query: { ecosystem: string; name: string; from?: string; to?: string },
  enabled = true,
) =>
  useQuery({
    queryKey: [
      'dependencies',
      'upgrade',
      query.ecosystem,
      query.name,
      query.from ?? '',
      query.to ?? '',
    ],
    queryFn: () => api.dependencyUpgrade(query),
    placeholderData: keepPreviousData,
    enabled,
    staleTime: 60_000,
  })

/** Library doc sections matching a query, best first; nothing is fetched for a blank query. */
export const useDependencyDocs = (query: {
  q: string
  ecosystem?: string
  name?: string
  version?: string
  limit?: number
}) =>
  useQuery({
    queryKey: ['dependencies', 'docs', query],
    queryFn: () => api.dependencyDocs(query),
    placeholderData: keepPreviousData,
    enabled: query.q.trim().length > 0,
    staleTime: 60_000,
  })

/** A rendered report, compared with `compare` or, by default, the previous record. */
export const useAnalysis = (analysisId: string, compare?: string, enabled = true) =>
  useQuery({
    queryKey: keys.analysis(analysisId, compare),
    queryFn: () => api.analysis(analysisId, compare),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
  })

/** Every bundle target of a repository with its size history. */
export const useBundleTargets = (repo: RepoRef) =>
  useQuery({
    queryKey: ['analyses', 'bundles', 'targets', repoKey(repo)],
    queryFn: () => api.bundleTargets(repo),
    staleTime: 60_000,
  })

/** The report of one point of a bundle target's history; the newest without version or analysis. */
export const useBundleReport = (
  repo: RepoRef,
  query: { target: string; version?: string | undefined; analysis?: string | undefined },
  enabled = true,
) =>
  useQuery({
    queryKey: [
      'analyses',
      'bundles',
      'report',
      repoKey(repo),
      query.target,
      query.version ?? '',
      query.analysis ?? '',
    ],
    queryFn: () => api.bundleReport(repo, query),
    enabled: enabled && Boolean(query.target),
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

/**
 * Tests an AI credential: a one-word reply for `ai-sdk`, the agent-loop probe for Anthropic kinds,
 * whose stored result refreshes the credential list.
 */
export const useTestCredential = () => {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, model }: { id: string; model?: string }) => api.testCredential(id, model),
    onSuccess: (result) =>
      result.capabilities ? client.invalidateQueries({ queryKey: keys.credentials }) : undefined,
  })
}

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
    reenableWebhooks: useMutation({
      mutationFn: () => api.reenableRepoWebhooks(repoKey(repo)),
      onSuccess: (view) => client.setQueryData(keys.repoUpdates(repo), view),
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

export const useSettings = (enabled = true) =>
  useQuery({ queryKey: keys.settings, queryFn: api.settings, enabled })

/** Every setting as it applies to a repository or a group, with winner and source; off without a focus. */
export const useResolvedScope = (focus: ScopeFocus | undefined) =>
  useQuery({
    queryKey: focus ? keys.resolved(focus) : ['settings', 'resolve', 'none'],
    queryFn: () => api.resolveSettings(focus!),
    enabled: focus !== undefined,
  })

export const useResolvedSettings = (repo: RepoRef | undefined) =>
  useResolvedScope(repo && { kind: 'repo', repo })

/** The resolver's answer for each repository, in order; one query per repository. */
export const useResolvedRepos = (repos: readonly RepoRef[]) =>
  useQueries({
    queries: repos.map((repo) => ({
      queryKey: keys.resolved({ kind: 'repo', repo }),
      queryFn: () => api.resolveSettings({ kind: 'repo', repo }),
    })),
  })

export function useSettingMutations() {
  const client = useQueryClient()
  const onSuccess = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: keys.settings }),
      client.invalidateQueries({ queryKey: ['assets'] }),
      client.invalidateQueries({ queryKey: ['coverage'] }),
      client.invalidateQueries({ queryKey: keys.repos }),
    ])
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

/** Guide, Notes and Learnings totals per Knowledge space the caller may read, for the sidebar. */
export const useKnowledgeCounts = (enabled = true) =>
  useQuery({ queryKey: keys.knowledgeCounts, queryFn: api.knowledgeCounts, enabled })

/** One knowledge entry with its history; off while `entryId` is unknown. */
export const useKnowledgeEntry = (entryId: string | undefined) =>
  useQuery({
    queryKey: [...keys.knowledge, 'entry', entryId ?? ''],
    queryFn: () => api.knowledgeEntry(entryId!),
    enabled: entryId !== undefined,
  })

/**
 * Create, edit, review and delete knowledge entries; each refreshes every knowledge list, and a
 * review also Inbox and Home.
 */
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
      onSuccess: () => Promise.all([onSuccess(), refreshDecisions(client)]),
    }),
    remove: useMutation({ mutationFn: (id: string) => api.deleteKnowledge(id), onSuccess }),
  }
}

/** One scope's Guide: every section with its layers, whether the caller may edit it, and people. */
export const useGuide = (scope: GuideScopeKey | undefined) =>
  useQuery({
    queryKey: scope ? keys.guideScope(scope) : ['guide', 'scope', 'none'],
    queryFn: () => api.guide(scope!),
    enabled: scope !== undefined,
  })

/** A section with the revisions of its human layer, loaded while the history sheet is open. */
export const useGuideSection = (scope: GuideScopeKey, section: GuideSectionName | undefined) =>
  useQuery({
    queryKey: section ? keys.guideSection(scope, section) : ['guide', 'section', 'none'],
    queryFn: () => api.guideSection(scope, section!),
    enabled: section !== undefined,
  })

/** The effective Guide a task of `repo` gets, with its budget and warnings. */
export const useGuidePreview = (repo: RepoRef | undefined, task: GuideTask) =>
  useQuery({
    queryKey: repo ? keys.guidePreview(repo, task) : ['guide', 'preview', 'none'],
    queryFn: () => api.guidePreview(repo!, task),
    enabled: repo !== undefined,
  })

/** The layered Guide chain of `repo` (one section, or all), with the budget; off without `repo`. */
export const useGuideChain = (repo: RepoRef | undefined, section?: GuideSectionName) =>
  useQuery({
    queryKey: repo ? keys.guideChain(repo, section) : ['guide', 'chain', 'none'],
    queryFn: () => api.guideChain(repo!, section),
    enabled: repo !== undefined,
  })

/** The repository's own rules files the chain reads first; off without `repo`. */
export const useGuideRepoFiles = (repo: RepoRef | undefined) =>
  useQuery({
    queryKey: repo ? keys.guideRepoFiles(repo) : ['guide', 'repo-files', 'none'],
    queryFn: () => api.guideRepoFiles(repo!),
    enabled: repo !== undefined,
  })

/** Every generated text a section stored, newest version first; off until `section` is given. */
export const useGuideGeneratedHistory = (
  scope: GuideScopeKey,
  section: GuideSectionName | undefined,
) =>
  useQuery({
    queryKey: section ? keys.guideGeneratedHistory(scope, section) : ['guide', 'generated', 'none'],
    queryFn: () => api.guideGeneratedHistory(scope, section!),
    enabled: section !== undefined,
  })

/**
 * Edit, restore and accept Guide sections, and queue regeneration; each refreshes every Guide
 * query, and accepting also Inbox and Home.
 */
export function useGuideMutations() {
  const client = useQueryClient()
  const onSuccess = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: keys.guide }),
      client.invalidateQueries({ queryKey: keys.knowledgeCounts }),
    ])
  return {
    save: useMutation({
      mutationFn: ({
        scope,
        section,
        input,
      }: {
        scope: GuideScopeKey
        section: GuideSectionName
        input: PutGuideSectionInput
      }) => api.putGuideSection(scope, section, input),
      onSuccess,
    }),
    restore: useMutation({
      mutationFn: ({
        scope,
        section,
        version,
      }: {
        scope: GuideScopeKey
        section: GuideSectionName
        version: number
      }) => api.restoreGuideSection(scope, section, version),
      onSuccess,
    }),
    accept: useMutation({
      mutationFn: ({
        scope,
        section,
        inputHash,
      }: {
        scope: GuideScopeKey
        section: GuideSectionName
        inputHash?: string
      }) => api.acceptGuideSection(scope, section, inputHash ? { inputHash } : {}),
      onSuccess: () => Promise.all([onSuccess(), refreshDecisions(client)]),
    }),
    reject: useMutation({
      mutationFn: (input: GuideSectionRejectInput) => api.rejectGuideSection(input),
      onSuccess: () => Promise.all([onSuccess(), refreshDecisions(client)]),
    }),
    regenerate: useMutation({
      mutationFn: ({ repo, input }: { repo: RepoRef; input: RegenerateGuideInput }) =>
        api.regenerateGuide(repo, input),
      onSuccess: () => client.invalidateQueries({ queryKey: keys.jobs }),
    }),
  }
}

/** Confirmed families the caller can see a member of. */
export const useFamilies = (enabled = true) =>
  useQuery({ queryKey: keys.families, queryFn: api.families, enabled })

/** Suggested families the caller could confirm. */
export const useFamilySuggestions = (enabled = true) =>
  useQuery({
    queryKey: [...keys.families, 'suggestions'],
    queryFn: api.familySuggestions,
    enabled,
  })

/** Create, edit and delete families; each refreshes families and every Guide. */
export function useFamilyMutations() {
  const client = useQueryClient()
  const onSuccess = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: keys.families }),
      client.invalidateQueries({ queryKey: keys.guide }),
    ])
  return {
    create: useMutation({ mutationFn: (input: FamilyInput) => api.createFamily(input), onSuccess }),
    update: useMutation({
      mutationFn: ({ id, input }: { id: string; input: FamilyInput }) =>
        api.updateFamily(id, input),
      onSuccess,
    }),
    remove: useMutation({ mutationFn: (id: string) => api.deleteFamily(id), onSuccess }),
    dismiss: useMutation({
      mutationFn: (members: string[]) => api.dismissFamilySuggestion({ members }),
      onSuccess: () => client.invalidateQueries({ queryKey: [...keys.families, 'suggestions'] }),
    }),
  }
}

/** Learning candidates the caller may read; `repo` keeps one repository's. */
export const useLearnings = (
  query: { repo?: RepoRef; status?: readonly LearningStatus[] },
  enabled = true,
) =>
  useQuery({
    queryKey: [
      ...keys.learnings,
      query.repo ? repoKey(query.repo) : '*',
      (query.status ?? []).join(','),
    ],
    queryFn: () => api.learnings(query),
    placeholderData: keepPreviousData,
    enabled,
  })

/** 👍/👎 totals per finding category; without `repo` it needs a global `knowledge:read` grant. */
export const useReactionTotals = (repo: RepoRef | undefined, enabled = true) =>
  useQuery({
    queryKey: [...keys.learnings, 'reactions', repo ? repoKey(repo) : '*'],
    queryFn: () => api.reactions(repo),
    enabled,
    retry: false,
  })

const refreshLearnings = (client: ReturnType<typeof useQueryClient>) =>
  Promise.all([
    client.invalidateQueries({ queryKey: keys.learnings }),
    client.invalidateQueries({ queryKey: keys.guide }),
    client.invalidateQueries({ queryKey: keys.knowledgeCounts }),
    refreshDecisions(client),
  ])

/**
 * Accept, edit and reject learning candidates; each refreshes learnings, every Guide, the
 * Knowledge counts, Inbox and Home.
 */
export function useLearningMutations() {
  const client = useQueryClient()
  const onSuccess = () => refreshLearnings(client)
  return {
    accept: useMutation({
      mutationFn: ({ id, input }: { id: string; input: AcceptLearningInput }) =>
        api.acceptLearning(id, input),
      onSuccess,
    }),
    edit: useMutation({
      mutationFn: ({ id, input }: { id: string; input: EditLearningInput }) =>
        api.editLearning(id, input),
      onSuccess,
    }),
    reject: useMutation({ mutationFn: (id: string) => api.rejectLearning(id), onSuccess }),
  }
}

/**
 * Accepts several learning candidates in one request; answers which were accepted and which
 * failed, and refreshes like a single accept (also after a partial failure).
 */
export function useAcceptLearnings() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: AcceptLearningsInput) => api.acceptLearnings(input),
    onSettled: () => refreshLearnings(client),
  })
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

/** Repositories the forge's token is a member of, matching `search`; off without a forge. */
export const useForgeRepositories = (forgeId: string | undefined, search: string) =>
  useQuery({
    queryKey: ['forge-repositories', forgeId ?? '', search],
    queryFn: () => api.forgeRepositories(forgeId ?? '', search),
    enabled: forgeId !== undefined,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: false,
  })

/** Checks up to 50 paths at once against the forge's token; results are not cached. */
export const useCheckRepoAccess = () =>
  useMutation({
    mutationFn: ({ forgeId, paths }: { forgeId: string; paths: readonly string[] }) =>
      api.checkRepoAccess(forgeId, { paths: [...paths] }),
  })

/** Repository groups of the effective config; needs global `settings:read`. */
export const useGroups = (enabled = true) =>
  useQuery({ queryKey: [...keys.config, 'groups'], queryFn: api.groups, enabled })

/** Creates or replaces a group in the panel config; refreshes groups and repositories. */
export function usePutGroup() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: GroupDocumentData }) => api.putGroup(id, data),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: keys.me })
      await client.invalidateQueries({ queryKey: keys.config })
      await client.invalidateQueries({ queryKey: keys.repos })
      await client.invalidateQueries({ queryKey: keys.settings })
    },
  })
}

/** Entries of one config collection; needs global `settings:read`. */
export const useConfigEntries = <C extends keyof ConfigCollections>(
  collection: C,
  enabled = true,
) =>
  useQuery({
    queryKey: [...keys.config, collection],
    queryFn: () => api.configEntries(collection),
    enabled,
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

/**
 * The repository hub's header and Overview: health strip, cards, freshness records, delivery data.
 * Not fetched while `enabled` is false (the reader lacks `analyses:read`).
 */
export const useRepoOverview = (repo: RepoRef, enabled = true) =>
  useQuery({
    queryKey: ['repo-page', 'overview', repoKey(repo)],
    queryFn: () => api.repoOverview(repo),
    staleTime: 60_000,
    enabled,
  })

/**
 * Review runs on readable repositories, newest first, one page per `limit` (server default when
 * absent); further pages continue from the previous page's `nextBefore`.
 */
export const useReviews = (query: Omit<ReviewQuery, 'before'> = {}, enabled = true) =>
  useInfiniteQuery({
    queryKey: ['reviews', 'list', query],
    queryFn: ({ pageParam }) =>
      api.reviews({ ...query, ...(pageParam ? { before: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextBefore,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    enabled,
  })

/** One review run with its findings; disabled without an id. */
export const useReview = (analysisId: string | undefined) =>
  useQuery({
    queryKey: ['reviews', 'detail', analysisId ?? 'none'],
    queryFn: () => api.review(analysisId!),
    enabled: analysisId !== undefined,
    staleTime: 5 * 60_000,
  })

/** Analyzers jobs can run, with their option schemas; `enabled` is false without jobs. */
export const useJobAnalyzers = () =>
  useQuery({
    queryKey: [...keys.jobs, 'analyzers'],
    queryFn: api.jobAnalyzers,
    staleTime: Infinity,
  })

const activeStatus = (status: string) => status === 'queued' || status === 'running'

/**
 * Jobs, newest first, a page at a time (paged by `before`); refreshes every few seconds while
 * some are queued or running. Off while `enabled` is false.
 */
export function useJobs(filter: JobQuery = {}, enabled = true, pageSize = 50) {
  return useInfiniteQuery({
    queryKey: [
      ...keys.jobs,
      'list',
      { ...filter, ...(filter.repo && { repo: repoKey(filter.repo) }) },
      pageSize,
    ],
    queryFn: ({ pageParam }) =>
      api.jobs({ ...filter, limit: pageSize, ...(pageParam ? { before: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) =>
      last.jobs.length < pageSize ? undefined : last.jobs.at(-1)?.createdAt,
    placeholderData: keepPreviousData,
    enabled,
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) => page.jobs.some((job) => activeStatus(job.status)))
        ? 3_000
        : 30_000,
  })
}

/**
 * Queue statistics over the jobs the viewer may read (narrowed to `repos` when given), with live
 * workers for viewers who read every job; refreshes every 10 seconds.
 */
export const useJobStats = (repos?: readonly string[], enabled = true) =>
  useQuery({
    queryKey: [...keys.jobs, 'stats', repos?.join(',') ?? ''],
    queryFn: () => api.jobStats(repos ? { repos } : {}),
    placeholderData: keepPreviousData,
    enabled,
    refetchInterval: 10_000,
  })

/** How many jobs match `filter` created since `filter.since`, by status (`GET /api/jobs/count`). */
export const useJobCount = (filter: JobQuery & { since?: string }, enabled = true) =>
  useQuery({
    queryKey: [...keys.jobs, 'count', filter],
    queryFn: () => api.jobCount(filter),
    placeholderData: keepPreviousData,
    enabled,
  })

/** Repositories and groups with jobs the viewer may read, with their groups, for the scope switch. */
export const useJobTargets = () =>
  useQuery({ queryKey: [...keys.jobs, 'targets'], queryFn: api.jobTargets, staleTime: 60_000 })

/** Failed jobs of the last `days` grouped by analyzer and failure signature. */
export const useJobFailures = (
  filter: { days?: number; analyzer?: string; repos?: readonly string[] },
  enabled = true,
) =>
  useQuery({
    queryKey: [...keys.jobs, 'failures', filter],
    queryFn: () => api.jobFailures(filter),
    placeholderData: keepPreviousData,
    enabled,
  })

/** Why a job ran and, while queued, what it waits for; refreshes with the job. */
export const useJobWhy = (jobId: string, status: string) =>
  useQuery({
    queryKey: [...keys.jobs, 'why', jobId, status],
    queryFn: () => api.jobWhy(jobId),
    refetchInterval: status === 'queued' ? 5_000 : false,
  })

/** The agent runs of a job with their cost; refreshes while the job runs. */
export const useJobRuns = (jobId: string, live: boolean) =>
  useQuery({
    queryKey: [...keys.jobs, 'runs', jobId],
    queryFn: () => api.jobRuns(jobId),
    refetchInterval: live ? 5_000 : false,
  })

/** One agent run's transcript of a job, loaded when opened. */
export const useJobTranscript = (jobId: string, ref: string | undefined) =>
  useQuery({
    queryKey: [...keys.jobs, 'transcript', jobId, ref ?? ''],
    queryFn: () => api.jobTranscript(jobId, ref ?? ''),
    enabled: ref !== undefined,
    staleTime: Infinity,
  })

/** Queues one analyzer for past releases; refreshes job lists. */
export function useBackfillAnalyses() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: AnalysisBackfillInput) => api.backfillAnalyses(input),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.jobs }),
  })
}

/**
 * The newest `limit` runs and the next five run times of every schedule; refreshes every few
 * seconds while a run is unfinished.
 */
export const useScheduleRuns = (limit = 10) =>
  useQuery({
    queryKey: [...keys.jobs, 'schedule-runs', limit],
    queryFn: () => api.scheduleRuns(limit),
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

/** Runs the new repository trigger on every repository Holtkeeper already knows. */
export function useRunNewRepoTrigger() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => api.runNewRepoTrigger(),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.jobs }),
  })
}

/** The last freshness sweep summed per team; refreshes every minute. */
export const useFreshnessOverview = () =>
  useQuery({
    queryKey: [...keys.jobs, 'freshness'],
    queryFn: api.freshnessOverview,
    refetchInterval: 60_000,
  })

/** One job with its attempts; refreshes while it is queued or running. */
export const useJob = (jobId: string | undefined) =>
  useQuery({
    queryKey: [...keys.jobs, 'detail', jobId ?? ''],
    queryFn: () => api.job(jobId ?? ''),
    enabled: jobId !== undefined,
    refetchInterval: (query) =>
      query.state.data && activeStatus(query.state.data.status) ? 2_000 : false,
  })

/**
 * The last `tail` lines of one attempt's log; while `live` (the attempt is running) it refreshes
 * every 2 seconds until the worker closed the log, and once more when `live` turns off.
 */
export const useJobLog = (jobId: string, attempt: number, live: boolean, tail = 1000) =>
  useQuery({
    queryKey: [...keys.jobs, 'log', jobId, attempt, tail, live],
    queryFn: () => api.jobLog(jobId, { attempt, tail }),
    enabled: attempt > 0,
    placeholderData: keepPreviousData,
    refetchInterval: (query) => (live && !query.state.data?.complete ? 2_000 : false),
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

/** One period of AI usage at a glance (default this week); needs `ai:read`. */
export const useAiOverview = (enabled = true, query: AiOverviewQuery = {}) =>
  useQuery({
    queryKey: [...keys.ai, 'overview', query],
    queryFn: () => api.aiOverview(query),
    enabled,
  })

/** AI usage sums grouped by `groupBy` (comma list of dimensions); off while `enabled` is false. */
export const useAiUsage = (filter: AiUsageQuery & { groupBy?: string }, enabled = true) =>
  useQuery({
    queryKey: [...keys.ai, 'usage', filter],
    queryFn: () => api.aiUsage(filter),
    placeholderData: keepPreviousData,
    enabled,
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

/** History events the caller may see, newest first, paged by cursor; off while `enabled` is false. */
export function useHistory(filter: HistoryQuery, enabled = true, pageSize = 50) {
  return useInfiniteQuery({
    queryKey: [...keys.history, 'list', filter],
    queryFn: ({ pageParam }) =>
      api.history({ ...filter, limit: pageSize, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
  })
}

/** The newest audit events about one repository, for the hub's Recent activity. */
export const useRepoHistory = (repo: RepoRef, limit = 6) =>
  useQuery({
    queryKey: [...keys.history, 'repo', repoKey(repo), limit],
    queryFn: () => api.history({ repos: repoKey(repo), limit }),
    staleTime: 60_000,
  })

/** The repositories the caller's History covers and whether it sees instance-level events. */
export const useHistoryScope = () =>
  useQuery({ queryKey: [...keys.history, 'scope'], queryFn: api.historyScope })

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

/** Size, tables, indexes, growth and advice of the store's database; needs global `settings:read`. */
export const useDatabase = () =>
  useQuery({ queryKey: keys.database, queryFn: api.database, refetchInterval: 60_000 })

/** Statement statistics of the database, top `limit` by `sort`; off until `enabled`. */
export const useDatabaseQueries = (sort: DatabaseQuerySort, enabled: boolean, limit = 100) =>
  useQuery({
    queryKey: [...keys.database, 'queries', sort, limit],
    queryFn: () => api.databaseQueries({ sort, limit }),
    enabled,
    refetchInterval: 30_000,
  })

/** Live client connections, refreshed every 5 seconds while `enabled`. */
export const useDatabaseSessions = (enabled: boolean) =>
  useQuery({
    queryKey: [...keys.database, 'sessions'],
    queryFn: api.databaseSessions,
    enabled,
    refetchInterval: 5_000,
  })

/** Clears statement statistics; refreshes the page. */
export function useResetDatabaseQueries() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: api.resetDatabaseQueries,
    onSuccess: () => client.invalidateQueries({ queryKey: keys.database }),
  })
}

/** The egress proxy's download cache; needs global `settings:read`. */
export const useEgressCache = () =>
  useQuery({ queryKey: keys.egressCache, queryFn: api.egressCache, refetchInterval: 30_000 })

/** Deletes cache entries, a whole kind or everything; refreshes the cache view. */
export function useDeleteEgressCache() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: DeleteEgressCacheInput) => api.deleteEgressCache(input),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.egressCache }),
  })
}

/** What the library index holds, its last run and the run going on; global `settings:read`. */
export const useLibraryIndex = (query: { q?: string; ecosystem?: string }) =>
  useQuery({
    queryKey: [...keys.libraries, 'index', query.q ?? '', query.ecosystem ?? ''],
    queryFn: () => api.libraryIndex(query),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    refetchInterval: (state) => (state.state.data?.progress ? 10_000 : false),
  })

/** Use and live limits of the GitHub tokens over the last `days`; refreshed every minute. */
export const useGitHubTokens = (days: number, enabled = true) =>
  useQuery({
    queryKey: [...keys.libraries, 'github', days],
    queryFn: () => api.githubTokens(days),
    placeholderData: keepPreviousData,
    enabled,
    retry: false,
    refetchInterval: 60_000,
  })

/** Starts an indexing run unless one is going; refreshes the library views. */
export function useReindexLibraries() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: api.reindexLibraries,
    onSuccess: () => client.invalidateQueries({ queryKey: keys.libraries }),
  })
}

/** Whether Slack app tokens are stored, and the review status emoji. */
export const useSlackSettings = (enabled: boolean) =>
  useQuery({ queryKey: keys.slack, queryFn: api.slackSettings, enabled })

/** Store or forget the Slack app tokens, or set its status emoji; each answers with the new settings. */
export function useSlackMutations() {
  const client = useQueryClient()
  const onSuccess = (view: SlackSettingsView) => client.setQueryData(keys.slack, view)
  return {
    connect: useMutation({ mutationFn: api.connectSlack, onSuccess }),
    disconnect: useMutation({ mutationFn: api.disconnectSlack, onSuccess }),
    setEmoji: useMutation({ mutationFn: api.setSlackEmoji, onSuccess }),
  }
}

/**
 * Team chat threads the caller can see, optionally only titles containing `q`; polls every 10 s
 * for new activity and unread counts.
 */
export const useChatThreads = (archived = false, q = '') =>
  useQuery({
    queryKey: [...keys.chat, 'threads', archived, q.trim()],
    queryFn: () => api.chatThreads(archived, q),
    placeholderData: keepPreviousData,
    refetchInterval: 10_000,
  })

/** Totals of one thread for its context column; polls every 30 s, off without a thread. */
export const useChatContext = (threadId: string | undefined) =>
  useQuery({
    queryKey: threadId ? keys.chatContext(threadId) : ['chat', 'context', 'none'],
    queryFn: () => api.chatContext(threadId!),
    enabled: threadId !== undefined,
    refetchInterval: 30_000,
  })

/** Unread chat messages across visible threads, for the rail badge; polls every 30 s. */
export const useChatUnread = (enabled = true) =>
  useQuery({
    queryKey: [...keys.chat, 'unread'],
    queryFn: api.chatUnread,
    enabled,
    refetchInterval: 30_000,
  })

const chatMessagesKey = (threadId: string | undefined) => [...keys.chat, 'messages', threadId]

/**
 * The messages of an open thread: the newest page once, then a poll every few seconds (faster
 * while the agent writes or a card is live) that folds in new and changed messages with `after`
 * and `changedSince`. `loadOlder` puts the page before the first message in front.
 */
export function useChatThread(threadId: string | undefined) {
  const client = useQueryClient()
  const key = chatMessagesKey(threadId)
  const messages = useQuery({
    queryKey: key,
    queryFn: () => api.chatMessages(threadId ?? '', { limit: 50 }),
    enabled: threadId !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
  })
  const data = messages.data
  useQuery({
    queryKey: [...keys.chat, 'poll', threadId],
    enabled: data !== undefined,
    queryFn: async () => {
      const current = client.getQueryData<ChatMessageList>(key)
      if (!current || !threadId) return null
      const poll = await api.chatMessages(threadId, {
        after: current.cursor,
        changedSince: current.serverTime,
        limit: 200,
      })
      client.setQueryData<ChatMessageList>(key, (now) => now && withNewer(now, poll))
      return poll.serverTime
    },
    refetchInterval:
      data?.thread.replying || hasLiveCards(data?.messages ?? [], new Date()) ? 1_500 : 3_000,
  })
  const loadOlder = useMutation({
    mutationFn: async () => {
      const current = client.getQueryData<ChatMessageList>(key)
      const first = current?.messages[0]
      if (!threadId || !first) return
      const older = await api.chatMessages(threadId, { before: first.seq, limit: 50 })
      client.setQueryData<ChatMessageList>(key, (now) => now && withOlder(now, older))
    },
  })
  return { messages, loadOlder }
}

/** People who can be mentioned in a thread. */
export const useChatPeople = (threadId: string | undefined) =>
  useQuery({
    queryKey: [...keys.chat, 'people', threadId],
    queryFn: () => api.chatPeople(threadId ?? ''),
    enabled: threadId !== undefined,
    staleTime: 60_000,
  })

/** The transcript of an agent reply, loaded when its tool trace is opened. */
export const useChatTranscript = (messageId: string, enabled: boolean) =>
  useQuery({
    queryKey: [...keys.chat, 'transcript', messageId],
    queryFn: () => api.chatTranscript(messageId),
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })

/**
 * Creates and changes threads, posts messages and moves read markers. A posted message goes
 * straight into the open thread and the next poll runs at once; thread lists and unread counts
 * refresh after each change.
 */
export function useChatMutations() {
  const client = useQueryClient()
  const refreshLists = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: [...keys.chat, 'threads'] }),
      client.invalidateQueries({ queryKey: [...keys.chat, 'unread'] }),
    ])
  return {
    create: useMutation({ mutationFn: api.createChatThread, onSuccess: refreshLists }),
    update: useMutation({
      mutationFn: ({ id, ...input }: { id: string } & ChatThreadPatchInput) =>
        api.updateChatThread(id, input),
      onSuccess: (thread) => {
        client.setQueryData<ChatMessageList>(
          chatMessagesKey(thread.id),
          (now) => now && { ...now, thread },
        )
        void client.invalidateQueries({ queryKey: keys.chatContext(thread.id) })
        return refreshLists()
      },
    }),
    post: useMutation({
      mutationFn: ({ id, ...input }: { id: string } & ChatPostInput) => api.postChat(id, input),
      onSuccess: (result, { id }) => {
        client.setQueryData<ChatMessageList>(
          chatMessagesKey(id),
          (now) =>
            now && {
              ...now,
              thread: { ...now.thread, replying: now.thread.replying || result.replying },
              messages: mergeMessages(now.messages, [result.message]),
            },
        )
        void client.invalidateQueries({ queryKey: [...keys.chat, 'poll', id] })
        void client.invalidateQueries({ queryKey: keys.chatContext(id) })
        return refreshLists()
      },
    }),
    read: useMutation({
      mutationFn: ({ id, messageId }: { id: string; messageId: string }) =>
        api.markChatRead(id, { messageId }),
      onSuccess: (_, { id }) => {
        client.setQueryData<ChatMessageList>(
          chatMessagesKey(id),
          (now) => now && { ...now, thread: { ...now.thread, unread: 0 } },
        )
        return refreshLists()
      },
    }),
  }
}

const tasksKey = ['tasks'] as const

const taskActive = (status: AgentTaskStatus) =>
  status === 'approved' || status === 'queued' || status === 'running'

/** Task groups the caller may see, newest first; polls every 5 seconds while one works. */
export const useTaskGroups = (enabled = true, limit = 100) =>
  useQuery({
    queryKey: [...tasksKey, 'groups', limit],
    queryFn: () => api.taskGroups({ limit }),
    enabled,
    refetchInterval: (query) =>
      query.state.data?.groups.some((group) => taskActive(group.status)) ? 5_000 : false,
  })

/** One task group with its people; polls every 3 seconds while it works. */
export const useTaskGroup = (groupId: string | undefined) =>
  useQuery({
    queryKey: [...tasksKey, 'group', groupId ?? ''],
    queryFn: () => api.taskGroup(groupId ?? ''),
    enabled: groupId !== undefined,
    refetchInterval: (query) =>
      query.state.data && taskActive(query.state.data.status) ? 3_000 : false,
  })

/** How many task groups the viewer sees that wait for approval, for the Tasks badge; every 30 s. */
export const useTaskApprovalCount = (enabled = true) =>
  useQuery({
    queryKey: [...tasksKey, 'needs-approval'],
    queryFn: api.taskApprovalCount,
    enabled,
    refetchInterval: 30_000,
  })

/** The `tasks.write` switch and caps with the write pool's status. */
export const useWriteTasks = (enabled = true) =>
  useQuery({ queryKey: [...tasksKey, 'write'], queryFn: api.writeTasks, enabled })

/**
 * Proposes, approves, rejects, cancels and retries agent tasks (one task, or every failed or
 * cancelled task of a group) and decides repositories a task asked for.
 * Task lists, open chat threads, Inbox and Home load again afterwards, so cards show the new
 * status at once.
 */
export function useTaskGroupMutations() {
  const client = useQueryClient()
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: [...keys.chat, 'poll'] }),
      client.invalidateQueries({ queryKey: tasksKey }),
      refreshDecisions(client),
    ])
  return {
    create: useMutation({ mutationFn: api.createTaskGroup, onSuccess: refresh }),
    approve: useMutation({ mutationFn: api.approveTaskGroup, onSuccess: refresh }),
    cancel: useMutation({ mutationFn: api.cancelTaskGroup, onSuccess: refresh }),
    reject: useMutation({ mutationFn: api.rejectTaskGroup, onSuccess: refresh }),
    retryGroup: useMutation({ mutationFn: api.retryTaskGroup, onSuccess: refresh }),
    retryTask: useMutation({ mutationFn: api.retryTask, onSuccess: refresh }),
    cancelTask: useMutation({ mutationFn: api.cancelTask, onSuccess: refresh }),
    decide: useMutation({
      mutationFn: ({ groupId, ...input }: { groupId: string; repo: string; approve: boolean }) =>
        api.decideTaskRepo(groupId, input),
      onSuccess: refresh,
    }),
  }
}

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
      await client.invalidateQueries({ queryKey: keys.history })
    },
  })
}

/** The signed-in principal's own UI preferences, such as its home groups. */
export const usePreferences = () =>
  useQuery({ queryKey: keys.preferences, queryFn: api.preferences, staleTime: 5 * 60_000 })

/** Saves the signed-in principal's preferences; `homeGroups: null` goes back to its grants. */
export function useSetPreferences() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: UserPreferencesInput) => api.setPreferences(input),
    onSuccess: (saved) => client.setQueryData(keys.preferences, saved),
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
    logout: useMutation({
      mutationFn: (url: string) => api.logout(url),
      onSuccess: async () => {
        clearRecent(browserStorage())
        await onSuccess()
      },
    }),
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

/** Packages of the API catalog, newest version each; filtered by a substring when `q` is set. */
export const usePublicApiPackages = (q?: string) =>
  useQuery({
    queryKey: ['public-api', 'packages', q ?? ''],
    queryFn: () => api.publicApiPackages(q),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  })

/** One version of a package in full, with every recorded version. */
export const usePublicApiPackage = (query: { name: string; version?: string; repo?: string }) =>
  useQuery({
    queryKey: ['public-api', 'package', query.name, query.version ?? '', query.repo ?? ''],
    queryFn: () => api.publicApiPackage(query),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  })

/** What changed between two versions; `from` defaults to the release before `to`. */
export const usePublicApiDiff = (
  query: { name: string; from?: string; to?: string; repo?: string },
  enabled = true,
) =>
  useQuery({
    queryKey: [
      'public-api',
      'diff',
      query.name,
      query.from ?? '',
      query.to ?? '',
      query.repo ?? '',
    ],
    queryFn: () => api.publicApiDiff(query),
    staleTime: 60_000,
    retry: false,
    enabled,
  })

/** Exported names across the catalog with facet counts; idle until there is a query. */
export const usePublicApiSearch = (query: Omit<PublicApiSearchQuery, 'limit'>, limit = 60) =>
  useQuery({
    queryKey: [
      'public-api',
      'search',
      query.q,
      query.package ?? '',
      query.repo ?? '',
      query.subpath ?? '',
      query.kind ?? '',
      query.match ?? '',
      limit,
    ],
    queryFn: () => api.publicApiSearch({ ...query, limit }),
    placeholderData: keepPreviousData,
    enabled: query.q.trim().length > 0,
    staleTime: 30_000,
  })

/** One exported name with its declaration, docs and history; idle while `query` is undefined. */
export const usePublicApiSymbol = (query: PublicApiSymbolQuery | undefined) =>
  useQuery({
    queryKey: [
      'public-api',
      'symbol',
      query?.package ?? '',
      query?.name ?? '',
      query?.subpath ?? '',
      query?.version ?? '',
      query?.repo ?? '',
      query?.limit ?? 0,
    ],
    queryFn: () => api.publicApiSymbol(query!),
    enabled: query !== undefined,
    staleTime: 60_000,
    retry: false,
  })

/** Who uses a package across repositories and which of its exports, members and props. */
export const usePackageUsage = (name: string) =>
  useQuery({
    queryKey: ['public-api', 'usages', 'package', name],
    queryFn: () => api.packageUsage(name),
    staleTime: 60_000,
  })

/** Uses of a package with snippets; idle while `enabled` is false. */
export const useUsageSites = (
  query: {
    package: string
    export?: string
    member?: string
    prop?: string
    kind?: string
    repo?: string
  },
  enabled = true,
) =>
  useQuery({
    queryKey: [
      'public-api',
      'usages',
      'sites',
      query.package,
      query.export ?? '',
      query.member ?? '',
      query.prop ?? '',
      query.kind ?? '',
      query.repo ?? '',
    ],
    queryFn: () => api.usageSites({ ...query, limit: 100 }),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    enabled,
  })

export function usePublicApiRescan() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: api.publicApiRescan,
    onSuccess: () => client.invalidateQueries({ queryKey: ['public-api'] }),
  })
}

/** The caller's MCP tokens. */
export const useMcpTokens = () => useQuery({ queryKey: ['mcp', 'tokens'], queryFn: api.mcpTokens })

export function useCreateMcpToken() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateMcpTokenInput) => api.createMcpToken(input),
    onSuccess: () => client.invalidateQueries({ queryKey: ['mcp', 'tokens'] }),
  })
}

export function useRevokeMcpToken() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (tokenId: string) => api.revokeMcpToken(tokenId),
    onSuccess: () => client.invalidateQueries({ queryKey: ['mcp', 'tokens'] }),
  })
}

/** The tools the MCP endpoint offers the caller, with their arguments. */
export const useMcpTools = () =>
  useQuery({ queryKey: ['mcp', 'tools'], queryFn: api.mcpTools, staleTime: 5 * 60_000 })

/** MCP calls of the last `days` days; refreshes every half minute. */
export const useMcpUsage = (days: number) =>
  useQuery({
    queryKey: ['mcp', 'usage', days],
    queryFn: () => api.mcpUsage(days),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  })

const deployActive = (state: DeployState | undefined) =>
  state?.environments.some((env) => env.status === 'pending' || env.status === 'running') ?? false

/**
 * Release cards of every repository with releases on, from the server's snapshot; refetches every
 * minute, every 3 s while the server reads the forges.
 */
export const useReleaseOverview = () =>
  useQuery({
    queryKey: keys.releaseOverview,
    queryFn: () => api.releaseOverview(),
    placeholderData: keepPreviousData,
    refetchInterval: (query) => (query.state.data?.refreshing ? 3_000 : 60_000),
  })

/** Past versions of one repository, newest first, a page at a time; the first page carries `next`. */
export const useReleaseTimeline = (repo: RepoRef | undefined, pageSize = 10) =>
  useInfiniteQuery({
    queryKey: repo ? keys.releaseTimeline(repo) : ['releases', 'timeline', 'none'],
    queryFn: ({ pageParam }) => api.releaseTimeline(repo!, pageParam, pageSize),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset,
    enabled: repo !== undefined,
  })

/** One version in full (entries, changelog, tasks, deploys); off while `tag` is unknown. */
export const useReleaseVersion = (repo: RepoRef, tag: string | undefined) =>
  useQuery({
    queryKey: keys.releaseVersion(repo, tag ?? ''),
    queryFn: () => api.releaseVersion(repo, tag!),
    enabled: tag !== undefined,
    staleTime: 5 * 60_000,
  })

/** Release page data of one repository; polls while a deploy of the latest version runs. */
export const useReleaseRepo = (repo: RepoRef | undefined) =>
  useQuery({
    queryKey: repo ? keys.releaseRepo(repo) : ['releases', 'repo', 'none'],
    queryFn: () => api.releaseRepo(repo!),
    enabled: repo !== undefined,
    placeholderData: keepPreviousData,
    refetchInterval: (query) => (deployActive(query.state.data?.deploy) ? 5_000 : 60_000),
  })

/**
 * The flow suggested for a repository from what it already does; read from the forge only while
 * `enabled` and on an explicit refetch, never by invalidating release queries.
 */
export const useReleaseDetect = (repo: RepoRef | undefined, enabled: boolean) =>
  useQuery({
    queryKey: repo ? keys.releaseDetect(repo) : ['release-detect', 'none'],
    queryFn: () => api.releaseDetect(repo!),
    enabled: enabled && repo !== undefined,
    staleTime: Infinity,
    retry: false,
  })

/** Deploy state of one version; polls while a job is pending or running. */
export const useReleaseDeploy = (repo: RepoRef, tag: string | undefined, initial?: DeployState) =>
  useQuery({
    queryKey: keys.releaseDeploy(repo, tag ?? ''),
    queryFn: () => api.releaseDeploy(repo, tag!),
    enabled: tag !== undefined,
    ...(initial && initial.tag === tag ? { initialData: initial } : {}),
    refetchInterval: (query) => (deployActive(query.state.data) ? 5_000 : 30_000),
  })

/** Every release action; each refreshes the release queries when it settles, accepting also Inbox and Home. */
export function useReleaseActions() {
  const client = useQueryClient()
  const onSettled = () => client.invalidateQueries({ queryKey: keys.releases })
  return {
    refresh: useMutation({
      mutationFn: () => api.releaseOverview(true),
      onSuccess: (data) => client.setQueryData(keys.releaseOverview, data),
    }),
    edits: useMutation({
      mutationFn: (input: ReleaseEditsInput) => api.saveReleaseEdits(input),
      onSettled,
    }),
    summary: useMutation({
      mutationFn: (input: ReleaseSummaryInput) => api.writeReleaseSummary(input),
      onSettled,
    }),
    step: useMutation({
      mutationFn: ({ step, ...input }: ReleaseStepInput & { step: 'propose' | 'version' }) =>
        api.runReleaseStep(step, input),
      onSettled,
    }),
    accept: useMutation({
      mutationFn: (input: ReleaseAcceptInput) => api.acceptRelease(input),
      onSettled: () => Promise.all([onSettled(), refreshDecisions(client)]),
    }),
    withdraw: useMutation({ mutationFn: (repo: RepoRef) => api.withdrawRelease(repo), onSettled }),
    deploy: useMutation({
      mutationFn: (input: ReleaseDeployInput) => api.startReleaseDeploy(input),
      onSettled,
    }),
  }
}

/** Patches the cached plan of a repository right away, before the server answers. */
export function usePatchReleaseView() {
  const client = useQueryClient()
  return (repo: RepoRef, patch: (view: ReleaseRepoView) => ReleaseRepoView) =>
    client.setQueryData<ReleaseRepoView>(keys.releaseRepo(repo), (view) =>
      view ? patch(view) : view,
    )
}
