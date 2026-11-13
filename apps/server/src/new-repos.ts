import { type HoltkeeperConfig, resolveRepo, rootGroups } from '@holtkeeper/core'
import type { RepoRef } from '@holtkeeper/forge'
import {
  type ForgeReaderFor,
  dailyLimitsOf,
  enqueueUnique,
  groupRepositories,
  planSchedule,
} from '@holtkeeper/jobs'
import { SYSTEM_ACTOR } from '@holtkeeper/store'

import { appendAudit } from './audit.ts'
import type { ServerDeps } from './context.ts'
import { automaticJobReady } from './jobs.ts'

type OnNewRepo = NonNullable<NonNullable<HoltkeeperConfig['jobs']>['onNewRepo']>

/**
 * Kinds `jobs.onNewRepo` queues: its `analyzers`, or every analyzer when it names none, minus
 * `exclude`, group-scope and `exclusive` ones and kinds the server does not have.
 */
export function newRepoAnalyzers(
  onNewRepo: OnNewRepo,
  analyzers: NonNullable<ServerDeps['analyzers']>,
): string[] {
  const exclude = new Set(onNewRepo.exclude ?? [])
  const readers = analyzers.filter(
    (analyzer) => analyzer.scope === 'repo' && !analyzer.exclusive && !exclude.has(analyzer.kind),
  )
  const wanted = onNewRepo.analyzers
  return readers
    .filter((analyzer) => wanted === undefined || wanted.includes(analyzer.kind))
    .map((analyzer) => analyzer.kind)
}

/**
 * Queues the `jobs.onNewRepo` analyzers for `repos`, limited to its `groups` and to analyzers
 * whose `appliesTo` matches (a failing check counts as applying) and whose options are valid with
 * the repository's `analyzers.<kind>` setting. Jobs get trigger `new-repo`, and kinds with a
 * `dailyLimit` are spread over the next days;
 * one already queued or running for the same analyzer and repository is skipped. Without `actor`
 * (repositories polling found for the first time) it logs `job.new_repo` per repository that got
 * jobs; with `actor` (a run by hand) the jobs carry it and the caller logs the run. Does nothing
 * without `jobs.onNewRepo`.
 */
export async function queueNewRepoJobs(
  deps: Pick<ServerDeps, 'config' | 'store' | 'analyzers' | 'now'>,
  repos: readonly RepoRef[],
  options: { forgeFor?: ForgeReaderFor; log?: (line: string) => void; actor?: string } = {},
): Promise<{ queued: number; skipped: number }> {
  const { config, store } = deps
  const onNewRepo = config.jobs?.onNewRepo
  const none = { queued: 0, skipped: 0 }
  if (!onNewRepo || repos.length === 0) return none
  const kinds = newRepoAnalyzers(onNewRepo, deps.analyzers ?? [])
  if (kinds.length === 0) return none
  const requests = await planSchedule(
    { analyzers: kinds, ...(onNewRepo.groups && { groups: onNewRepo.groups }) },
    {
      config,
      analyzers: (deps.analyzers ?? []).filter((analyzer) => kinds.includes(analyzer.kind)),
      resolveRepos: async (group) =>
        repos.filter((repo) => resolveRepo(config, repo).groups.includes(group)),
      ...(options.forgeFor && { forgeFor: options.forgeFor }),
      ...(options.log && { log: options.log }),
    },
  )
  const byKind = new Map((deps.analyzers ?? []).map((analyzer) => [analyzer.kind, analyzer]))
  const ready = await Promise.all(
    requests.map(async (request) => {
      const analyzer = byKind.get(request.analyzer)
      return !analyzer || automaticJobReady(config, store, analyzer, request)
    }),
  )
  const at = deps.now().toISOString()
  const { enqueued, skipped } = await enqueueUnique(
    store.jobs,
    requests
      .filter((_, index) => ready[index])
      .map((request) => ({
        ...request,
        trigger: 'new-repo' as const,
        ...(options.actor && { actor: options.actor }),
      })),
    at,
    { dailyLimits: dailyLimitsOf(deps.analyzers ?? []) },
  )
  const result = { queued: enqueued.length, skipped: skipped.length }
  if (options.actor) return result
  const byRepo = new Map<string, string[]>()
  for (const job of enqueued) {
    const subject = `${job.repo.forge}:${job.repo.path}`
    byRepo.set(subject, [...(byRepo.get(subject) ?? []), job.id])
  }
  for (const [repo, jobs] of byRepo)
    // oxlint-disable-next-line no-await-in-loop -- one audit event per repository, in order
    await appendAudit(store, {
      at,
      actor: SYSTEM_ACTOR,
      via: 'system',
      action: 'repo.discover',
      target: { type: 'repo', repo },
      outcome: 'ok',
      details: { jobs },
    })
  return result
}

/**
 * Every repository of the config's root groups (subgroups only narrow them), listed on their forges now, for running
 * `jobs.onNewRepo` on repositories Holtkeeper already knows. A group that cannot be listed is
 * reported in `failed` and left out.
 */
export async function knownRepos(
  config: HoltkeeperConfig,
): Promise<{ repos: RepoRef[]; failed: string[] }> {
  const found = new Map<string, RepoRef>()
  const failed: string[] = []
  const list = groupRepositories(config)
  for (const group of rootGroups(config)) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one group after another keeps rate limits
      for (const repo of await list(group)) found.set(`${repo.forge}:${repo.path}`, repo)
    } catch (error) {
      failed.push(`${group}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { repos: [...found.values()], failed }
}
