import {
  type Action,
  type Principal,
  type RepoTarget,
  can,
  teamsOfPrincipal,
} from '@holtkeeper/access'
import type { ReleaseCard, RepoList, RepoSummary } from '@holtkeeper/api'
import type { RepoRef } from '@holtkeeper/forge'
import { analyzerOff, resolveRepoTests } from '@holtkeeper/settings'
import { Hono } from 'hono'

import { type Env, type ServerDeps, principalOf, repoKey, repoTarget } from '../context.ts'
import { releaseServiceFor } from '../releases.ts'
import { indexSources, readHealthSources, repoHealth } from '../repo-health.ts'
import { listedRepos, repoUpdatesSummaries } from '../updates.ts'
import { canSee } from '../visibility.ts'

/** Any of these on a repository lists it. */
const LISTING_ACTIONS: Action[] = ['repos:read', 'audits:read', 'analyses:read', 'releases:read']

/**
 * Teams `principal` may know about: every team with global `settings:read`, otherwise the teams it
 * is a member of, the teams its grants name and the owner teams of fleet repositories it holds a
 * listing permission on. Only configured teams.
 */
export async function reachableTeams(
  deps: Pick<ServerDeps, 'store' | 'config'>,
  principal: Principal,
): Promise<Set<string>> {
  const configured = Object.keys(deps.config.teams)
  if (can(principal, 'settings:read', { kind: 'global' })) return new Set(configured)
  const reach = new Set([
    ...teamsOfPrincipal(deps.config.teams, principal),
    ...principal.grants.flatMap((grant) => grant.scope.teams ?? []),
  ])
  for (const repo of await listedRepos(deps.store.kv, deps.config)) {
    const target = repoTarget(deps.config, repo)
    if (LISTING_ACTIONS.some((action) => canSee(principal, action, target)))
      for (const team of target.teams) reach.add(team)
  }
  return new Set(configured.filter((team) => reach.has(team)))
}

/** What `repoSummaries` reads from the server; `analyses` lets health compute missing metrics. */
type FleetDeps = Pick<ServerDeps, 'store' | 'config' | 'analyzers' | 'now'> &
  Partial<Pick<ServerDeps, 'analyses'>>

/** Who reads the fleet: the permissions it holds per repository, and the release cards it may see. */
export interface FleetReader {
  can(action: Action, target: RepoTarget): boolean
  /** Stored release cards; without it the release cell is left out. */
  releases?: () => Promise<ReleaseCard[]>
}

/**
 * Every fleet repository (from the stored listings plus exact include paths) that
 * `reader` holds a listing permission on, sorted by `forge:path`, with the health cells, freshness,
 * updates and newest audit run it may read; whatever it may not read is absent. Repositories
 * without any record are listed as `not-analysed`; `noTests` marks those `repo.tests` turns off.
 * A repository whose audit `repo.analyzers` turns off has no `latestAudit`.
 */
export async function repoSummaries(deps: FleetDeps, reader: FleetReader): Promise<RepoSummary[]> {
  const { config, store } = deps
  const members = new Map<string, RepoRef>()
  for (const repo of await listedRepos(store.kv, config)) members.set(repoKey(repo), repo)
  const visible = [...members.values()]
    .map((repo) => repoTarget(config, repo))
    .filter((target) => LISTING_ACTIONS.some((action) => reader.can(action, target)))
    .toSorted((a, b) => repoKey(a).localeCompare(repoKey(b)))
  const reads = (action: Action) => visible.filter((target) => reader.can(action, target))
  const audited = new Set(reads('audits:read').map(repoKey))
  const releases = reader.releases && reads('releases:read').length ? reader.releases : undefined
  const labels = new Set((deps.analyzers ?? []).map((analyzer) => analyzer.kind))

  const sources = await readHealthSources(
    { store, analyses: deps.analyses ?? [], now: deps.now },
    {
      jobRepos: reads('analyses:read').map(({ forge, path }) => ({ forge, path })),
      ...(releases && { releases }),
      audits: audited.size > 0,
      ...(labels.size && { known: (kind: string) => labels.has(kind) }),
    },
  )
  const indexed = indexSources(sources)
  const updates = store.kv
    ? await repoUpdatesSummaries(store.kv, sources.settings, reads('settings:read'), sources.now)
    : undefined

  return visible.map((target): RepoSummary => {
    const key = repoKey(target)
    const health = repoHealth(
      indexed,
      target,
      (action) =>
        reader.can(action, target) && (action !== 'releases:read' || releases !== undefined),
    )
    const run =
      audited.has(key) && !analyzerOff(sources.settings, target, 'audit')
        ? indexed.audits.get(key)
        : undefined
    const updated = updates?.get(key)
    const tests = resolveRepoTests(sources.settings, target)
    return {
      repo: { forge: target.forge, path: target.path },
      teams: target.teams,
      ...(reader.can('settings:write', target) && { configurable: true as const }),
      ...health,
      ...(updated && { updates: updated }),
      ...(run && { latestAudit: run }),
      ...(!tests.expected && {
        noTests: tests.reason === undefined ? {} : { reason: tests.reason },
      }),
    }
  })
}

/** `GET /api/repos`: every fleet repository the caller may read, with its health. */
export function repoRoutes(deps: ServerDeps) {
  const app = new Hono<Env>()

  app.get('/repos', async (c) => {
    const principal = principalOf(c)
    const repos = await repoSummaries(deps, {
      can: (action, target) => canSee(principal, action, target),
      releases: () => releaseServiceFor(deps).snapshot(principal),
    })
    return c.json<RepoList>({ repos })
  })

  return app
}
