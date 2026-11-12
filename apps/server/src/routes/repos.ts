import {
  type Action,
  type Principal,
  type RepoTarget,
  can,
  groupLineage,
  groupNames,
  leafGroups,
  parentGroup,
} from '@holtkeeper/access'
import type { ReleaseCard, RepoList, RepoSummary } from '@holtkeeper/api'
import type { RepoRef } from '@holtkeeper/forge'
import { resolveRepoTests } from '@holtkeeper/settings'
import { Hono } from 'hono'

import { type Env, type ServerDeps, principalOf, repoKey, repoTarget } from '../context.ts'
import { releaseServiceFor } from '../releases.ts'
import { indexSources, readHealthSources, repoHealth } from '../repo-health.ts'
import { listedRepos, repoUpdatesSummaries } from '../updates.ts'
import { canSee } from '../visibility.ts'

/** Any of these on a repository lists it. */
const LISTING_ACTIONS: Action[] = ['repos:read', 'audits:read', 'analyses:read', 'releases:read']

/**
 * Config groups `principal` may know about: every group with global `settings:read`, otherwise the
 * groups its grants name plus the groups of listed repositories it holds a listing permission on,
 * with the subgroups of every such group and the parent of every such subgroup.
 */
export async function reachableGroups(
  deps: Pick<ServerDeps, 'store' | 'config'>,
  principal: Principal,
): Promise<Set<string>> {
  const configured = Object.keys(deps.config.groups)
  if (can(principal, 'settings:read', { kind: 'global' })) return new Set(configured)
  const granted = new Set(principal.grants.flatMap((grant) => groupNames(grant.scope.groups ?? [])))
  const reach = new Set(granted)
  for (const repo of await listedRepos(deps.store.kv, deps.config)) {
    const target = repoTarget(deps.config, repo)
    if (LISTING_ACTIONS.some((action) => canSee(principal, action, target)))
      for (const group of leafGroups(target.groups)) reach.add(group)
  }
  const withSubgroups = configured.filter(
    (group) => reach.has(group) || granted.has(parentGroup(group) ?? ''),
  )
  const withParents = new Set(withSubgroups.flatMap(groupLineage))
  return new Set(configured.filter((group) => withParents.has(group)))
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
 * Every member of the configured groups (from the stored listings plus exact include paths) that
 * `reader` holds a listing permission on, sorted by `forge:path`, with the health cells, freshness,
 * updates and newest audit run it may read; whatever it may not read is absent. Repositories
 * without any record are listed as `not-analysed`; `noTests` marks those `repo.tests` turns off.
 */
export async function repoSummaries(deps: FleetDeps, reader: FleetReader): Promise<RepoSummary[]> {
  const { config, store } = deps
  const members = new Map<string, RepoRef>()
  for (const repo of await listedRepos(store.kv, config)) members.set(repoKey(repo), repo)
  const visible = [...members.values()]
    .map((repo) => repoTarget(config, repo))
    .filter(
      (target) =>
        target.groups.length > 0 && LISTING_ACTIONS.some((action) => reader.can(action, target)),
    )
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
    const run = audited.has(key) ? indexed.audits.get(key) : undefined
    const updated = updates?.get(key)
    const tests = resolveRepoTests(sources.settings, target)
    return {
      repo: { forge: target.forge, path: target.path },
      groups: target.groups,
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

/** `GET /api/repos`: every group member the caller may read, with its health. */
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
