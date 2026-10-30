import { memoryExternalAccounts } from './accounts.ts'
import { memoryAiUsage } from './ai-usage.ts'
import { memoryAudit } from './audit.ts'
import { memoryConfig, memoryKv } from './config.ts'
import { DEFAULT_MAX_ATTEMPTS, JOB_LOG_LIMIT } from './jobs.ts'
import { memoryKnowledge } from './knowledge.ts'
import type {
  ActivityEvent,
  AnalysisRecord,
  AuditRun,
  Identity,
  Job,
  JobStore,
  LinkToken,
  Passkey,
  SettingEntry,
  Store,
  StoredCredential,
  User,
} from './types.ts'

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
  const activity: ActivityEvent[] = []
  const jobs = memoryJobs()
  const externalAccounts = memoryExternalAccounts()

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
      async list({ repo, kind, before, limit = 50 } = {}) {
        const matching = [...analyses.values()].filter(
          (record) =>
            (!repo || (record.repo.forge === repo.forge && record.repo.path === repo.path)) &&
            (!kind || record.kind === kind) &&
            (!before || record.createdAt < before),
        )
        return newestFirst(matching, (record) => record.createdAt)
          .slice(0, limit)
          .map(clone)
      },
    },
    credentials: {
      list: async () => [...credentials.values()].map(clone),
      get: async (id) => clone(credentials.get(id)),
      put: async (credential) => void credentials.set(credential.id, clone(credential)),
      remove: async (id) => void credentials.delete(id),
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
      putUser: async (user) => void users.set(user.id, clone(user)),
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
    activity: {
      async append(event) {
        const stored = { ...clone(event), id: crypto.randomUUID() }
        activity.push(stored)
        return clone(stored)
      },
      async list({ before, limit = 50 } = {}) {
        return newestFirst(
          activity.filter((event) => !before || event.at < before),
          (e) => e.at,
        )
          .slice(0, limit)
          .map(clone)
      },
    },
    jobs,
    knowledge: memoryKnowledge(),
    aiUsage: memoryAiUsage(),
    config: memoryConfig(),
    kv: memoryKv(),
    audit: memoryAudit(),
    externalAccounts,
    close: async () => {},
  }
}

const sameRepo = (a: { forge: string; path: string }, b: { forge: string; path: string }) =>
  a.forge === b.forge && a.path === b.path

function memoryJobs(): JobStore {
  const jobs = new Map<string, Job>()
  const order = new Map<string, number>()
  let seq = 0

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
        log: [],
        ...(input.actor !== undefined && { actor: input.actor }),
      }
      jobs.set(job.id, job)
      order.set(job.id, seq++)
      return clone(job)
    },
    async claim(workerId, now) {
      const busy = [...jobs.values()].filter((job) => job.status === 'running')
      const next = [...jobs.values()]
        .filter(
          (job) =>
            job.status === 'queued' &&
            job.runAfter <= now &&
            !busy.some((other) => sameRepo(other.repo, job.repo)),
        )
        .toSorted(
          (a, b) =>
            a.runAfter.localeCompare(b.runAfter) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
        )[0]
      if (!next) return undefined
      next.status = 'running'
      next.attempts += 1
      next.workerId = workerId
      next.startedAt = now
      next.heartbeatAt = now
      delete next.finishedAt
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
      if (analysisId !== undefined) job.analysisId = analysisId
      return clone(job)
    },
    async fail(id, { at, error, retryAt }) {
      const job = running(id)
      if (!job) return undefined
      job.error = error
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
    async cancel(id, at) {
      const job = jobs.get(id)
      if (!job) return undefined
      if (job.status === 'queued' || job.status === 'running') {
        job.status = 'canceled'
        job.finishedAt = at
      }
      return clone(job)
    },
    async recoverStale(heartbeatBefore, at) {
      const changed: Job[] = []
      for (const job of jobs.values()) {
        if (job.status !== 'running' || (job.heartbeatAt ?? '') >= heartbeatBefore) continue
        job.error = 'worker stopped responding'
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
    async list({ status, repo, analyzer, before, limit = 50 } = {}) {
      const statuses = status === undefined ? undefined : [status].flat()
      const matching = [...jobs.values()].filter(
        (job) =>
          (!statuses || statuses.includes(job.status)) &&
          (!repo || sameRepo(job.repo, repo)) &&
          (!analyzer || job.analyzer === analyzer) &&
          (!before || job.createdAt < before),
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
    async appendLog(id, lines) {
      const job = jobs.get(id)
      if (job) job.log = [...job.log, ...lines].slice(-JOB_LOG_LIMIT)
    },
  }
}
