import {
  type Principal,
  type RepoTarget,
  type Scope,
  can,
  scopeCoversRepo,
} from '@holtkeeper/access'
import { budgetKey, budgetStatuses, weekBreakdown, weekRange } from '@holtkeeper/ai-usage'
import type { ReleaseCard } from '@holtkeeper/api'
import type { RepoRef } from '@holtkeeper/forge'
import { readJobLog } from '@holtkeeper/jobs'
import type { AiUsageFilter, Job } from '@holtkeeper/store'

import { type ServerDeps, groupLabeler, parseRepo, repoKey, repoTarget } from './context.ts'
import { freshnessStatus } from './freshness.ts'
import { type CostReader, jobStats } from './job-stats.ts'
import { explainJob } from './job-why.ts'
import {
  type HealthAccess,
  indexSources,
  principalHealthAccess,
  readHealthSources,
  repoHealth,
} from './repo-health.ts'
import { aiReadScopes } from './routes/ai.ts'
import { costReaderOf, jobTarget } from './routes/jobs.ts'
import { repoSummaries } from './routes/repos.ts'
import type { OpsToolsAccess } from './tools/ops.ts'
import { canSee } from './visibility.ts'

/** Options of `opsToolsAccess`. */
interface OpsToolsAccessOptions {
  /** Whether the caller may read the jobs of a repository (group jobs count as their group). */
  canRead: (target: RepoTarget) => boolean
  /** Skips the per-repository filter: the caller reads every job. */
  readAll?: boolean
  /** Which jobs' agent cost the caller may read; without it `queue_stats` shows no spend. */
  readsCost?: CostReader
  /** Which budgets the caller may read; without it `budget_status` is not offered. */
  canReadBudget?: (scope: Scope) => boolean
  /** List the implicit default budget when no global one is set. */
  includeDefaultBudget?: boolean
  /** The AI usage `budget_status` splits by task kind, analyzer and provider; set with `canReadBudget`. */
  usage?: AiUsageFilter
  /** Which health cells the caller may read on a repository. */
  cells: (target: RepoTarget) => HealthAccess
  /** Stored release cards for the release cell; without it the cell is left out. */
  releaseCards?: () => Promise<ReleaseCard[]>
}

const readsAi = (principal: Principal) =>
  principal.grants.some((grant) =>
    grant.actions.some((action) => action === '*' || action === 'ai:read' || action === 'ai:admin'),
  )

/** The AI usage a principal may read: everything, or what its `ai:read` scopes cover. */
const usageOf = (principal: Principal): AiUsageFilter => {
  const scopes = aiReadScopes(principal)
  return scopes === 'all' ? {} : { scopes }
}

/** What `opsToolsAccess` reads from the server; `analyses` lets health compute missing metrics. */
type OpsDeps = Pick<ServerDeps, 'store' | 'config' | 'artifacts' | 'analyzers' | 'now'> &
  Partial<Pick<ServerDeps, 'analyses'>>

/** Stored release cards `analysis_status` judges releases by; without them the cell is left out. */
type ReleaseCards = () => Promise<ReleaseCard[]>

/**
 * What the `ops` toolset reads for one caller, over the server's job store, artifact store (job
 * logs) and AI usage: jobs, logs, explanations, queue stats (as `GET /api/jobs/stats`, workers
 * only with `readAll`) and freshness of the repositories `canRead` allows, health cells `cells` allows (also across the fleet, which lists a repository when
 * `cells` allows any listing permission on it), budgets `canReadBudget` allows. Nothing here
 * writes or queues.
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
    stats: async () =>
      jobStats(deps, await visibleRepos(), options.readAll === true, options.readsCost),
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
    health: async (repo) => {
      const group = config.groups[repo.path]
      if (group && group.forge === repo.forge) return undefined
      const target = repoTarget(config, repo)
      const allowed = options.cells(target)
      const { releaseCards } = options
      const access: HealthAccess = (action) =>
        allowed(action) && (action !== 'releases:read' || releaseCards !== undefined)
      const known = new Set((deps.analyzers ?? []).map((analyzer) => analyzer.kind))
      const sources = await readHealthSources(
        { store, analyses: deps.analyses ?? [], now: deps.now },
        {
          repo,
          jobRepos: access('analyses:read') ? [repo] : [],
          ...(releaseCards && access('releases:read') && { releases: releaseCards }),
          audits: access('audits:read'),
          ...(known.size && { known: (kind: string) => known.has(kind) }),
        },
      )
      return repoHealth(indexSources(sources), target, access)
    },
    fleet: () =>
      repoSummaries(deps, {
        can: (action, target) => options.cells(target)(action),
        ...(options.releaseCards && { releases: options.releaseCards }),
      }),
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
      spend: async () => {
        const at = deps.now()
        return weekBreakdown(store.aiUsage, weekRange(at), options.usage ?? { scopes: [] })
      },
    }),
    groupLabel: groupLabeler(config),
  }
}

/**
 * The `ops` access of an MCP caller: jobs it may `analyses:read`, health cells it holds the
 * permission of (the release cell only with `releaseCards`), budgets and the week's AI usage it may
 * `ai:read` (the default budget only with instance-wide `ai:read`).
 */
export function principalOpsAccess(
  deps: OpsDeps,
  principal: Principal,
  releaseCards?: ReleaseCards,
): OpsToolsAccess {
  const budget = (scope: Scope) =>
    can(principal, 'ai:read', { kind: 'scope', scope }) ||
    can(principal, 'ai:admin', { kind: 'scope', scope })
  return opsToolsAccess(deps, {
    canRead: (target) => canSee(principal, 'analyses:read', target),
    readAll: can(principal, 'analyses:read', { kind: 'global' }),
    readsCost: costReaderOf(deps.config, principal),
    cells: (target) => principalHealthAccess(principal, target),
    ...(releaseCards && { releaseCards }),
    ...(readsAi(principal) && {
      canReadBudget: budget,
      includeDefaultBudget: budget({ all: true }),
      usage: usageOf(principal),
    }),
  })
}

/**
 * The `ops` access of an internal agent working on `repo` (team chat): jobs and health of that
 * repository and of repositories sharing a group with it, the budgets that cover the
 * repository, the default one included, and the week's AI usage of its groups (of the repository
 * alone without groups). When a person asked, jobs also need their
 * `analyses:read`, each health cell its own permission of theirs and budgets their `ai:read` or
 * `ai:admin` (the default budget only instance-wide). The release cell needs `releaseCards`. Who
 * asked for a job is never part of what the tools return.
 */
export function agentOpsAccess(
  deps: OpsDeps,
  repo: RepoTarget,
  requester?: Principal,
  releaseCards?: ReleaseCards,
): OpsToolsAccess {
  const own = repoKey(repo)
  const readsBudget = (scope: Scope) =>
    !requester ||
    can(requester, 'ai:read', { kind: 'scope', scope }) ||
    can(requester, 'ai:admin', { kind: 'scope', scope })
  const reach = (other: RepoTarget) =>
    repoKey(other) === own || other.groups.some((group) => repo.groups.includes(group))
  return opsToolsAccess(deps, {
    canRead: (other) => reach(other) && (!requester || canSee(requester, 'analyses:read', other)),
    cells: (other) => (action) => reach(other) && (!requester || canSee(requester, action, other)),
    ...(releaseCards && { releaseCards }),
    ...((!requester || readsAi(requester)) && {
      canReadBudget: (scope: Scope) =>
        (scope.all === true || scopeCoversRepo(scope, repo)) && readsBudget(scope),
      includeDefaultBudget: readsBudget({ all: true }),
      usage: {
        ...(repo.groups.length
          ? { groups: repo.groups }
          : { repo: { forge: repo.forge, path: repo.path } }),
        ...(requester && usageOf(requester)),
      },
    }),
  })
}
