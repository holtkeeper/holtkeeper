import {
  type Principal,
  type RepoTarget,
  type Scope,
  can,
  scopeCoversRepo,
} from '@holtkeeper/access'
import { budgetKey, budgetStatuses } from '@holtkeeper/ai-usage'
import type { RepoRef } from '@holtkeeper/forge'
import { readJobLog } from '@holtkeeper/jobs'
import type { Job } from '@holtkeeper/store'

import { type ServerDeps, parseRepo } from './context.ts'
import { freshnessStatus } from './freshness.ts'
import { explainJob } from './job-why.ts'
import { jobTarget } from './routes/jobs.ts'
import type { OpsToolsAccess } from './tools/ops.ts'
import { canSee } from './visibility.ts'

/** Options of `opsToolsAccess`. */
interface OpsToolsAccessOptions {
  /** Whether the caller may read the jobs of a repository (group jobs count as their group). */
  canRead: (target: RepoTarget) => boolean
  /** Skips the per-repository filter: the caller reads every job. */
  readAll?: boolean
  /** Which budgets the caller may read; without it `budget_status` is not offered. */
  canReadBudget?: (scope: Scope) => boolean
  /** List the implicit default budget when no global one is set. */
  includeDefaultBudget?: boolean
}

const keyOf = (repo: RepoRef) => `${repo.forge}:${repo.path}`

const readsAi = (principal: Principal) =>
  principal.grants.some((grant) =>
    grant.actions.some((action) => action === '*' || action === 'ai:read' || action === 'ai:admin'),
  )

/** What `opsToolsAccess` reads from the server. */
export type OpsDeps = Pick<ServerDeps, 'store' | 'config' | 'artifacts' | 'analyzers' | 'now'>

/**
 * What the `ops` toolset reads for one caller, over the server's job store, artifact store (job
 * logs) and AI usage: jobs, logs, explanations and freshness of the repositories `canRead`
 * allows, budgets `canReadBudget` allows. Nothing here writes or queues.
 */
function opsToolsAccess(deps: OpsDeps, options: OpsToolsAccessOptions): OpsToolsAccess {
  const { store, config } = deps
  const readable = (job: Pick<Job, 'repo' | 'group'>) =>
    options.readAll === true || options.canRead(jobTarget(config, job))

  const visibleRepos = async (): Promise<RepoRef[] | undefined> =>
    options.readAll ? undefined : (await store.jobs.targets()).filter(readable).map((t) => t.repo)

  const { canReadBudget } = options
  return {
    repoOf: (value) => {
      const repo = parseRepo(value)
      if (!repo) return undefined
      const group = config.groups[repo.path]
      const target = group && group.forge === repo.forge ? { repo, group: repo.path } : { repo }
      return readable(target) ? repo : undefined
    },
    jobs: async (query) => {
      const repos = await visibleRepos()
      return store.jobs.list({ ...query, ...(repos && { repos }) })
    },
    job: async (id) => {
      const job = await store.jobs.get(id)
      return job && readable(job) ? job : undefined
    },
    log: async (job, attempt, tail) =>
      deps.artifacts
        ? readJobLog(deps.artifacts, job.id, attempt, { tail })
        : { total: 0, offset: 0, lines: [], complete: false, steps: [] },
    why: async (job) => {
      const { people: _people, ...why } = await explainJob(deps, job)
      return why
    },
    freshness: async (repo) => {
      const group = config.groups[repo.path]
      return freshnessStatus(
        deps,
        group && group.forge === repo.forge ? { repo, group: repo.path } : { repo },
      )
    },
    ...(canReadBudget && {
      budgets: async () =>
        budgetStatuses(
          (await store.settings.list(budgetKey)).filter((entry) => canReadBudget(entry.scope)),
          store.aiUsage,
          deps.now(),
          { includeDefault: options.includeDefaultBudget === true },
        ),
    }),
  }
}

/**
 * The `ops` access of an MCP caller: jobs it may `analyses:read`, budgets it may `ai:read` (the
 * default budget only with instance-wide `ai:read`).
 */
export function principalOpsAccess(deps: OpsDeps, principal: Principal): OpsToolsAccess {
  const budget = (scope: Scope) =>
    can(principal, 'ai:read', { kind: 'scope', scope }) ||
    can(principal, 'ai:admin', { kind: 'scope', scope })
  return opsToolsAccess(deps, {
    canRead: (target) => canSee(principal, 'analyses:read', target),
    readAll: can(principal, 'analyses:read', { kind: 'global' }),
    ...(readsAi(principal) && {
      canReadBudget: budget,
      includeDefaultBudget: budget({ all: true }),
    }),
  })
}

/**
 * The `ops` access of an internal agent working on `repo` (team chat): jobs of that repository
 * and of repositories sharing a group with it, and the budgets that cover the repository,
 * the default one included. When a person asked, jobs also need their `analyses:read` and
 * budgets their `ai:read` or `ai:admin` (the default budget only instance-wide). Who asked for a
 * job is never part of what the tools return.
 */
export function agentOpsAccess(
  deps: OpsDeps,
  repo: RepoTarget,
  requester?: Principal,
): OpsToolsAccess {
  const own = keyOf(repo)
  const readsBudget = (scope: Scope) =>
    !requester ||
    can(requester, 'ai:read', { kind: 'scope', scope }) ||
    can(requester, 'ai:admin', { kind: 'scope', scope })
  return opsToolsAccess(deps, {
    canRead: (other) =>
      (keyOf(other) === own || other.groups.some((group) => repo.groups.includes(group))) &&
      (!requester || canSee(requester, 'analyses:read', other)),
    ...((!requester || readsAi(requester)) && {
      canReadBudget: (scope: Scope) =>
        (scope.all === true || scopeCoversRepo(scope, repo)) && readsBudget(scope),
      includeDefaultBudget: readsBudget({ all: true }),
    }),
  })
}
