import { type Action, type Principal, can } from '@holtkeeper/access'
import { budgetKey, budgetStatuses } from '@holtkeeper/ai-usage'
import type { HomeSpend, HomeView } from '@holtkeeper/api'
import { summarizeRun } from '@holtkeeper/api'
import type { RepoRef } from '@holtkeeper/forge'
import { staticPrefix } from '@holtkeeper/jobs'
import type { AuditEvent } from '@holtkeeper/store'
import { Hono } from 'hono'

import { type Env, type ServerDeps, parseRepo, principalOf, repoTarget } from '../context.ts'
import {
  CHANGES_DAYS,
  changeActionPrefixes,
  type HomeSources,
  type RepoAudits,
  attentionItems,
  repoTiles,
  summarizeChanges,
} from '../home.ts'
import { releaseServiceFor } from '../releases.ts'
import { canSee } from '../visibility.ts'
import { aiReadScopes, canReadAiScope } from './ai.ts'
import { peopleOf } from './avatars.ts'
import { jobTarget } from './jobs.ts'

const DAY_MS = 86_400_000
const CACHE_MS = 30_000
const CACHE_ENTRIES = 200

const keyOf = (repo: RepoRef) => `${repo.forge}:${repo.path}`

const GLOBAL = { kind: 'global' } as const

/** The caller's spend this week against the budget covering the most, `undefined` without one. */
async function spendOf(deps: ServerDeps, principal: Principal): Promise<HomeSpend | undefined> {
  const scopes = aiReadScopes(principal)
  if (scopes !== 'all' && !scopes.length) return undefined
  const at = deps.now()
  const entries = (await deps.store.settings.list(budgetKey)).filter((entry) =>
    canReadAiScope(principal, entry.scope),
  )
  const budgets = await budgetStatuses(entries, deps.store.aiUsage, at, {
    includeDefault: canReadAiScope(principal, { all: true }),
  })
  const budget =
    budgets.find((status) => status.scope.all) ??
    budgets.toSorted((a, b) => b.percent - a.percent)[0]
  if (!budget) return undefined
  const buckets = await deps.store.aiUsage.aggregate({
    from: budget.week.from,
    to: budget.week.to,
    groupBy: ['taskKind'],
    filter: { scopes: [budget.scope] },
  })
  return {
    budgetId: budget.id,
    week: { from: budget.week.from, to: budget.week.to },
    spentUsd: budget.spentUsd,
    weeklyUsd: budget.weeklyUsd,
    reserveUsd: budget.reserveUsd,
    projectedUsd: budget.projectedUsd,
    action: budget.action,
    byFeature: buckets
      .filter((bucket) => bucket.costUsd > 0)
      .map((bucket) => ({
        feature: bucket.key.taskKind || 'other',
        costUsd: bucket.costUsd,
        runs: bucket.runs - bucket.denied,
      }))
      .toSorted((a, b) => b.costUsd - a.costUsd || a.feature.localeCompare(b.feature)),
  }
}

/** History events of the last `CHANGES_DAYS` days the caller may see, as `GET /history` filters them. */
async function eventsOf(deps: ServerDeps, principal: Principal): Promise<AuditEvent[]> {
  const readAll = can(principal, 'audit:read', GLOBAL)
  const reachable =
    readAll ||
    principal.grants.some((grant) =>
      grant.actions.some((action) => action === '*' || action === 'repos:read'),
    )
  if (!reachable) return []
  const repos = readAll
    ? undefined
    : (await deps.store.audit.repos()).filter((key) => {
        const ref = parseRepo(key)
        return ref !== undefined && canSee(principal, 'repos:read', repoTarget(deps.config, ref))
      })
  const from = new Date(deps.now().getTime() - CHANGES_DAYS * DAY_MS).toISOString()
  const pages = await Promise.all(
    changeActionPrefixes.map((action) =>
      deps.store.audit.list({ from, action, outcome: 'ok', ...(repos && { repos }), limit: 500 }),
    ),
  )
  const events = pages.flatMap((page) => page.events)
  return [...new Map(events.map((event) => [event.id, event])).values()]
}

/** Everything Home is computed from, narrowed to what `principal` may read; no forge calls. */
async function sourcesOf(
  deps: ServerDeps,
  principal: Principal,
): Promise<{ sources: HomeSources; repos: Set<string> }> {
  const { store, config } = deps
  const now = deps.now()
  const groupsOf = (key: string) => {
    const ref = parseRepo(key)
    return ref ? repoTarget(config, ref).groups : []
  }
  const sees = (action: Action, repo: RepoRef) =>
    canSee(principal, action, repoTarget(config, repo))
  const labels = new Map(
    (deps.analyzers ?? []).map((analyzer) => [
      analyzer.kind,
      analyzer.analysis?.label ?? analyzer.kind,
    ]),
  )
  const analyzerLabel = (kind: string) => labels.get(kind) ?? kind
  const since = new Date(now.getTime() - DAY_MS).toISOString()

  const jobRepos = can(principal, 'analyses:read', GLOBAL)
    ? undefined
    : (await store.jobs.targets())
        .filter((target) => canSee(principal, 'analyses:read', jobTarget(config, target)))
        .map((target) => target.repo)
  const scoped = jobRepos && { repos: jobRepos }
  const releases = releaseServiceFor(deps)

  const [failedJobs, blockedJobs, recentJobs, runs, cards, learnings, knowledge, heads] =
    await Promise.all([
      store.jobs.list({ status: 'failed', ...scoped, limit: 200 }),
      store.jobs.list({ status: 'blocked', ...scoped, limit: 100 }),
      store.jobs.list({ ...scoped, limit: 500 }),
      store.auditRuns.list({ limit: 300 }),
      releases.snapshot(principal),
      store.learnings.list({ status: ['proposed'] }),
      store.knowledge.list({ status: 'proposed' }),
      store.analyses.latestHeads(),
    ])

  const audits = new Map<string, RepoAudits>()
  for (const run of runs) {
    if (!sees('audits:read', run.repo)) continue
    const key = keyOf(run.repo)
    const entry = audits.get(key)
    if (!entry) audits.set(key, { latest: summarizeRun(run) })
    else if (!entry.previous) entry.previous = summarizeRun(run)
  }

  const known = labels.size ? (kind: string) => labels.has(kind) : () => true
  const analyses = heads.filter((head) => known(head.kind) && sees('analyses:read', head.repo))

  const sources: HomeSources = {
    now,
    groupsOf,
    analyzerLabel,
    failedJobs: failedJobs.filter((job) => (job.finishedAt ?? job.createdAt) >= since),
    blockedJobs: blockedJobs.filter((job) => (job.finishedAt ?? job.createdAt) >= since),
    recentJobs,
    audits: [...audits.values()],
    releases: cards,
    learnings: learnings.filter((candidate) => {
      const repo = parseRepo(candidate.repo)
      return repo !== undefined && sees('knowledge:write', repo)
    }),
    knowledge: knowledge.filter((entry) =>
      can(principal, 'knowledge:write', { kind: 'scope', scope: entry.scope }),
    ),
    analyses,
  }

  const repos = new Set<string>()
  for (const job of recentJobs) if (job.group === undefined) repos.add(keyOf(job.repo))
  for (const key of audits.keys()) repos.add(key)
  for (const card of cards) repos.add(keyOf(card.repo))
  for (const head of analyses) repos.add(keyOf(head.repo))
  for (const group of Object.values(config.groups))
    for (const path of group.include) {
      if (staticPrefix(path) !== path) continue
      const ref = { forge: group.forge, path }
      if (sees('repos:read', ref)) repos.add(keyOf(ref))
    }
  return { sources, repos }
}

/** Builds `GET /api/home` for one principal. */
async function buildHome(deps: ServerDeps, principal: Principal): Promise<HomeView> {
  const [{ sources, repos }, events, spend] = await Promise.all([
    sourcesOf(deps, principal),
    eventsOf(deps, principal),
    spendOf(deps, principal),
  ])
  const changes = summarizeChanges(events, sources.groupsOf)
  return {
    generatedAt: sources.now.toISOString(),
    attention: attentionItems(sources),
    changes,
    changesDays: CHANGES_DAYS,
    ...(spend && { spend }),
    repos: repoTiles(sources, repos),
    people: await peopleOf(
      deps,
      changes.flatMap((change) => change.actors),
    ),
  }
}

/**
 * `GET /api/home`: Needs attention, What changed, this week's AI spend and the repository grid in
 * one read from stored data, permission filtered. Answers are kept per principal and grants for 30
 * seconds.
 */
export function homeRoutes(deps: ServerDeps) {
  const app = new Hono<Env>()
  const cache = new Map<string, { expires: number; view: HomeView }>()

  app.get('/home', async (c) => {
    const principal = principalOf(c)
    const id = JSON.stringify([principal.id, principal.grants])
    const at = deps.now().getTime()
    const hit = cache.get(id)
    if (hit && hit.expires > at) return c.json<HomeView>(hit.view)
    const view = await buildHome(deps, principal)
    cache.delete(id)
    cache.set(id, { expires: at + CACHE_MS, view })
    while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!)
    return c.json<HomeView>(view)
  })

  return app
}
