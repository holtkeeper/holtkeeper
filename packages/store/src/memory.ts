import { memoryExternalAccounts } from './accounts.ts'
import { memoryAiUsage } from './ai-usage.ts'
import { memoryAudit } from './audit.ts'
import { memoryChat } from './chat.ts'
import { memoryCiJobs } from './ci-jobs.ts'
import { memoryConfig, memoryKv } from './config.ts'
import { memoryFamilies, memoryGuides } from './guides.ts'
import {
  claimDueBy,
  DEFAULT_MAX_ATTEMPTS,
  errorSignature,
  jobCounts,
  matchesJobSearch,
  STALE_JOB_ERROR,
} from './jobs.ts'
import { memoryKnowledge } from './knowledge.ts'
import { memoryLearnings } from './learnings.ts'
import { memoryLibraries } from './libraries.ts'
import { memorySlackMessages } from './slack.ts'
import { memoryTasks } from './tasks.ts'
import type {
  AnalysisQuery,
  AnalysisRecord,
  AuditRun,
  Identity,
  Job,
  JobAttempt,
  JobCountQuery,
  JobFailureGroup,
  JobStatus,
  JobStore,
  JobTarget,
  LinkToken,
  Passkey,
  SettingEntry,
  Store,
  StoredCredential,
  User,
} from './types.ts'

export { memoryCiJobs }

const later = (a: string | undefined, b: string | undefined) =>
  a === undefined ? b : b === undefined || a >= b ? a : b

const clone = <T>(value: T): T => structuredClone(value)
const newestFirst = <T>(items: T[], at: (item: T) => string) =>
  items.toSorted((a, b) => at(b).localeCompare(at(a)))

/** A `Store` kept in process memory. For tests and throwaway local runs; nothing survives a restart. */
export function memoryStore(): Store {
  const auditRuns = new Map<string, AuditRun>()
  const analyses = new Map<string, AnalysisRecord>()
  const credentials = new Map<string, StoredCredential>()
  const settings = new Map<string, SettingEntry>()
  const users = new Map<string, User>()
  const passkeys = new Map<string, Passkey>()
  const identities = new Map<string, Identity>()
  const tokens = new Map<string, LinkToken>()
  const jobs = memoryJobs()
  const externalAccounts = memoryExternalAccounts()

  const listAnalyses = ({ repo, kind, before, since, limit = 50 }: AnalysisQuery = {}) =>
    newestFirst(
      [...analyses.values()].filter(
        (record) =>
          (!repo || (record.repo.forge === repo.forge && record.repo.path === repo.path)) &&
          (!kind || record.kind === kind) &&
          (!before || record.createdAt < before) &&
          (!since || record.createdAt >= since),
      ),
      (record) => record.createdAt,
    ).slice(0, limit)

  const latestAnalyses = ({ repo, kind }: Pick<AnalysisQuery, 'repo' | 'kind'> = {}) => {
    const newest = new Map<string, AnalysisRecord>()
    for (const record of analyses.values()) {
      if (repo && (record.repo.forge !== repo.forge || record.repo.path !== repo.path)) continue
      if (kind && record.kind !== kind) continue
      const key = `${record.repo.forge}\n${record.repo.path}\n${record.kind}`
      const current = newest.get(key)
      if (!current || record.createdAt >= current.createdAt) newest.set(key, record)
    }
    return newestFirst([...newest.values()], (record) => record.createdAt)
  }

  return {
    auditRuns: {
      async add(run) {
        const stored = { ...clone(run), id: crypto.randomUUID() }
        auditRuns.set(stored.id, stored)
        return clone(stored)
      },
      get: async (id) => clone(auditRuns.get(id)),
      async list({ repo, before, limit = 50 } = {}) {
        const matching = [...auditRuns.values()].filter(
          (run) =>
            (!repo || (run.repo.forge === repo.forge && run.repo.path === repo.path)) &&
            (!before || run.finishedAt < before),
        )
        return newestFirst(matching, (run) => run.finishedAt)
          .slice(0, limit)
          .map(clone)
      },
    },
    analyses: {
      async add(record) {
        const stored = { ...clone(record), id: crypto.randomUUID() }
        analyses.set(stored.id, stored)
        return clone(stored)
      },
      get: async (id) => clone(analyses.get(id)),
      list: async (query) => listAnalyses(query).map(clone),
      heads: async (query) =>
        listAnalyses(query).map((record) => {
          const { data: _, ...head } = clone(record)
          return head
        }),
      latest: async (query) => latestAnalyses(query).map(clone),
      latestHeads: async (query) =>
        latestAnalyses(query).map((record) => {
          const { data: _, ...head } = clone(record)
          return head
        }),
      async prune({ repo, kind, keep }) {
        const stale = newestFirst(
          [...analyses.values()]
            .filter(
              (record) =>
                record.kind === kind &&
                record.repo.forge === repo.forge &&
                record.repo.path === repo.path,
            )
            .toReversed(),
          (record) => record.createdAt,
        ).slice(Math.max(keep, 0))
        for (const record of stale) analyses.delete(record.id)
        return stale.length
      },
    },
    credentials: {
      list: async () => [...credentials.values()].map(clone),
      get: async (id) => clone(credentials.get(id)),
      async put(credential) {
        const lastUsedAt = later(credentials.get(credential.id)?.lastUsedAt, credential.lastUsedAt)
        const { lastUsedAt: _, ...rest } = clone(credential)
        credentials.set(credential.id, { ...rest, ...(lastUsedAt && { lastUsedAt }) })
      },
      remove: async (id) => void credentials.delete(id),
      async touch(id, at) {
        const credential = credentials.get(id)
        if (credential) credential.lastUsedAt = later(credential.lastUsedAt, at)
      },
    },
    settings: {
      list: async (key) =>
        [...settings.values()].filter((entry) => !key || entry.key === key).map(clone),
      get: async (id) => clone(settings.get(id)),
      put: async (entry) => void settings.set(entry.id, clone(entry)),
      remove: async (id) => void settings.delete(id),
    },
    users: {
      listUsers: async () => [...users.values()].map(clone),
      getUser: async (id) => clone(users.get(id)),
      findUserByEmail: async (email) =>
        clone(
          [...users.values()].find((user) => user.email?.toLowerCase() === email.toLowerCase()),
        ),
      async putUser(user) {
        const lastSeenAt = later(users.get(user.id)?.lastSeenAt, user.lastSeenAt)
        const { lastSeenAt: _, ...rest } = clone(user)
        users.set(user.id, { ...rest, ...(lastSeenAt && { lastSeenAt }) })
      },
      async touchUser(id, at) {
        const user = users.get(id)
        if (user) user.lastSeenAt = later(user.lastSeenAt, at)
      },
      async removeUser(id) {
        users.delete(id)
        for (const [key, passkey] of passkeys) if (passkey.userId === id) passkeys.delete(key)
        for (const [key, identity] of identities) if (identity.userId === id) identities.delete(key)
        for (const [key, token] of tokens) if (token.userId === id) tokens.delete(key)
        externalAccounts.removeUser(id)
      },
      listPasskeys: async (userId) =>
        [...passkeys.values()].filter((p) => p.userId === userId).map(clone),
      getPasskey: async (id) => clone(passkeys.get(id)),
      putPasskey: async (passkey) => void passkeys.set(passkey.id, clone(passkey)),
      removePasskey: async (id) => void passkeys.delete(id),
      findIdentity: async (provider, subject) =>
        clone(identities.get(`${provider}\u0000${subject}`)),
      listIdentities: async (userId) =>
        [...identities.values()].filter((i) => i.userId === userId).map(clone),
      putIdentity: async (identity) =>
        void identities.set(`${identity.provider}\u0000${identity.subject}`, clone(identity)),
      putLinkToken: async (token) => void tokens.set(token.tokenHash, clone(token)),
      getLinkToken: async (hash) => clone(tokens.get(hash)),
    },
    jobs,
    knowledge: memoryKnowledge(),
    guides: memoryGuides(),
    families: memoryFamilies(),
    learnings: memoryLearnings(),
    aiUsage: memoryAiUsage(),
    ciJobs: memoryCiJobs(),
    chat: memoryChat(),
    tasks: memoryTasks(),
    config: memoryConfig(),
    kv: memoryKv(),
    audit: memoryAudit(),
    externalAccounts,
    libraries: memoryLibraries(),
    slackMessages: memorySlackMessages(),
    close: async () => {},
  }
}

const sameRepo = (a: { forge: string; path: string }, b: { forge: string; path: string }) =>
  a.forge === b.forge && a.path === b.path

const inRepos = (job: Job, repos: { forge: string; path: string }[] | undefined) =>
  !repos || repos.some((repo) => sameRepo(job.repo, repo))

function matchesJobQuery(job: Job, query: JobCountQuery): boolean {
  const { status, repo, analyzer, schedule, trigger, repos, analysisId } = query
  const statuses = status === undefined ? undefined : [status].flat()
  return (
    (!statuses || statuses.includes(job.status)) &&
    (!repo || sameRepo(job.repo, repo)) &&
    inRepos(job, repos) &&
    (!analyzer || job.analyzer === analyzer) &&
    (!schedule || job.schedule === schedule) &&
    (!trigger || job.trigger === trigger) &&
    (!query.errorSignature || job.errorSignature === query.errorSignature) &&
    (!analysisId || job.analysisId === analysisId) &&
    matchesJobSearch(job, query.search)
  )
}

/** Ends the job's latest attempt with `patch`, when it is still running. */
function endAttempt(job: Job, patch: Omit<Partial<JobAttempt>, 'n' | 'startedAt'>) {
  const last = job.attemptsHistory.at(-1)
  if (!last || last.status !== 'running') return
  Object.assign(
    last,
    Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
  )
}

function memoryJobs(): JobStore {
  const jobs = new Map<string, Job>()
  const order = new Map<string, number>()
  let seq = 0

  const ahead = (a: Job, b: Job) =>
    a.runAfter.localeCompare(b.runAfter) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)

  const running = (id: string) => {
    const job = jobs.get(id)
    return job?.status === 'running' ? job : undefined
  }

  return {
    async enqueue(input) {
      const job: Job = {
        id: crypto.randomUUID(),
        analyzer: input.analyzer,
        repo: clone(input.repo),
        ...(input.group !== undefined && { group: input.group }),
        ...(input.ref !== undefined && { ref: input.ref }),
        options: clone(input.options ?? {}),
        trigger: input.trigger,
        status: 'queued',
        attempts: 0,
        maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        runAfter: input.runAfter ?? input.createdAt,
        createdAt: input.createdAt,
        attemptsHistory: [],
        ...(input.actor !== undefined && { actor: input.actor }),
        ...(input.schedule !== undefined && { schedule: input.schedule }),
        ...(input.reason !== undefined && { reason: input.reason }),
      }
      jobs.set(job.id, job)
      order.set(job.id, seq++)
      return clone(job)
    },
    async claim(
      workerId,
      now,
      { exclusive = [], after = {}, delayMs, only, except = [], priority = [] } = {},
    ) {
      const dueBy = claimDueBy(now, delayMs)
      const urgent = (job: Job) => priority.includes(job.analyzer)
      const inPool = (job: Job) =>
        (!only || only.includes(job.analyzer)) && !except.includes(job.analyzer)
      const all = [...jobs.values()]
      const blocked = (job: Job) =>
        all.some(
          (other) =>
            other !== job &&
            sameRepo(other.repo, job.repo) &&
            ((other.status === 'running' &&
              (other.analyzer === job.analyzer || exclusive.includes(job.analyzer))) ||
              ((exclusive.includes(other.analyzer) ||
                (after[job.analyzer] ?? []).includes(other.analyzer)) &&
                (other.status === 'running' ||
                  (!urgent(job) && other.status === 'queued' && ahead(other, job) < 0)))),
        )
      const next = all
        .filter(
          (job) =>
            job.status === 'queued' &&
            job.runAfter <= (urgent(job) ? now : dueBy) &&
            inPool(job) &&
            !blocked(job),
        )
        .toSorted((a, b) => Number(urgent(b)) - Number(urgent(a)) || ahead(a, b))[0]
      if (!next) return undefined
      next.status = 'running'
      next.attempts += 1
      next.workerId = workerId
      next.startedAt = now
      next.heartbeatAt = now
      delete next.finishedAt
      next.attemptsHistory.push({
        n: next.attempts,
        status: 'running',
        startedAt: now,
        workerId,
      })
      return clone(next)
    },
    async heartbeat(id, workerId, now) {
      const job = running(id)
      if (!job || job.workerId !== workerId) return false
      job.heartbeatAt = now
      return true
    },
    async complete(id, { at, analysisId }) {
      const job = running(id)
      if (!job) return undefined
      job.status = 'succeeded'
      job.finishedAt = at
      delete job.error
      delete job.errorSignature
      endAttempt(job, { status: 'succeeded', finishedAt: at })
      if (analysisId !== undefined) job.analysisId = analysisId
      return clone(job)
    },
    async fail(id, { at, error, retryAt, step }) {
      const job = running(id)
      if (!job) return undefined
      job.error = error
      job.errorSignature = errorSignature(error)
      endAttempt(job, { status: 'failed', finishedAt: at, error, step })
      if (retryAt !== undefined && job.attempts < job.maxAttempts) {
        job.status = 'queued'
        job.runAfter = retryAt
        delete job.workerId
      } else {
        job.status = 'failed'
        job.finishedAt = at
      }
      return clone(job)
    },
    async block(id, { at, error }) {
      const job = running(id)
      if (!job) return undefined
      job.status = 'blocked'
      job.error = error
      delete job.errorSignature
      job.finishedAt = at
      endAttempt(job, { status: 'blocked', finishedAt: at, error })
      return clone(job)
    },
    async cancel(id, at) {
      const job = jobs.get(id)
      if (!job) return undefined
      if (job.status === 'queued' || job.status === 'running') {
        if (job.status === 'running') endAttempt(job, { status: 'canceled', finishedAt: at })
        job.status = 'canceled'
        job.finishedAt = at
      }
      return clone(job)
    },
    async recoverStale(heartbeatBefore, at) {
      const changed: Job[] = []
      for (const job of jobs.values()) {
        if (job.status !== 'running' || (job.heartbeatAt ?? '') >= heartbeatBefore) continue
        job.error = STALE_JOB_ERROR
        job.errorSignature = errorSignature(STALE_JOB_ERROR)
        endAttempt(job, { status: 'failed', finishedAt: at, error: STALE_JOB_ERROR })
        if (job.attempts < job.maxAttempts) {
          job.status = 'queued'
          job.runAfter = at
          delete job.workerId
        } else {
          job.status = 'failed'
          job.finishedAt = at
        }
        changed.push(clone(job))
      }
      return changed
    },
    get: async (id) => clone(jobs.get(id)),
    async list(query = {}) {
      const { before, limit = 50 } = query
      const matching = [...jobs.values()].filter(
        (job) => matchesJobQuery(job, query) && (!before || job.createdAt < before),
      )
      return matching
        .toSorted(
          (a, b) =>
            b.createdAt.localeCompare(a.createdAt) ||
            (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0),
        )
        .slice(0, limit)
        .map(clone)
    },
    async count(query = {}) {
      const counts = new Map<JobStatus, number>()
      for (const job of jobs.values())
        if (matchesJobQuery(job, query) && (!query.since || job.createdAt >= query.since))
          counts.set(job.status, (counts.get(job.status) ?? 0) + 1)
      return jobCounts(counts)
    },
    async failures({ since, analyzer, repos, limit = 50 }) {
      const groups = new Map<string, JobFailureGroup & { members: Set<string> }>()
      const failed = [...jobs.values()]
        .filter(
          (job) =>
            job.status === 'failed' &&
            job.errorSignature !== undefined &&
            job.finishedAt !== undefined &&
            job.finishedAt >= since &&
            (!analyzer || job.analyzer === analyzer) &&
            inRepos(job, repos),
        )
        .toSorted(
          (a, b) =>
            (a.finishedAt ?? '').localeCompare(b.finishedAt ?? '') ||
            (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
        )
      for (const job of failed) {
        const signature = job.errorSignature ?? ''
        const at = job.finishedAt ?? ''
        const key = JSON.stringify([job.analyzer, signature])
        const group = groups.get(key) ?? {
          analyzer: job.analyzer,
          errorSignature: signature,
          count: 0,
          repos: 0,
          firstAt: at,
          lastAt: at,
          latestJobId: job.id,
          error: job.error ?? '',
          members: new Set<string>(),
        }
        group.count++
        group.members.add(`${job.repo.forge}:${job.repo.path}`)
        group.repos = group.members.size
        group.lastAt = at
        group.latestJobId = job.id
        group.error = job.error ?? ''
        groups.set(key, group)
      }
      return [...groups.values()]
        .toSorted((a, b) => b.lastAt.localeCompare(a.lastAt))
        .slice(0, limit)
        .map(({ members: _members, ...group }) => group)
    },
    async targets() {
      const seen = new Map<string, JobTarget>()
      for (const job of jobs.values()) {
        const key = JSON.stringify([job.repo.forge, job.repo.path, job.group ?? null])
        if (!seen.has(key))
          seen.set(key, {
            repo: clone(job.repo),
            ...(job.group !== undefined && { group: job.group }),
          })
      }
      return [...seen.values()]
    },
  }
}
