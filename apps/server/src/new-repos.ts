import { type HoltkeeperConfig, resolveRepo } from '@holtkeeper/core'
import type { RepoRef } from '@holtkeeper/forge'
import { type ForgeReaderFor, enqueueUnique, planSchedule } from '@holtkeeper/jobs'

import type { ServerDeps } from './context.ts'

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
 * Queues the `jobs.onNewRepo` analyzers for repositories seen for the first time, limited to its
 * `groups` and to analyzers whose `appliesTo` matches (a failing check counts as applying). Jobs
 * get trigger `new-repo`; one already queued or running for the same analyzer and repository is
 * not queued again. Logs `job.new_repo` per repository that got jobs and resolves with how many
 * were queued. Does nothing without `jobs.onNewRepo`.
 */
export async function queueNewRepoJobs(
  deps: Pick<ServerDeps, 'config' | 'store' | 'analyzers' | 'now'>,
  repos: readonly RepoRef[],
  options: { forgeFor?: ForgeReaderFor; log?: (line: string) => void } = {},
): Promise<number> {
  const { config, store } = deps
  const onNewRepo = config.jobs?.onNewRepo
  if (!onNewRepo || repos.length === 0) return 0
  const kinds = newRepoAnalyzers(onNewRepo, deps.analyzers ?? [])
  if (kinds.length === 0) return 0
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
  const at = deps.now().toISOString()
  const { enqueued } = await enqueueUnique(
    store.jobs,
    requests.map((request) => ({ ...request, trigger: 'new-repo' as const })),
    at,
  )
  const byRepo = new Map<string, string[]>()
  for (const job of enqueued) {
    const subject = `${job.repo.forge}:${job.repo.path}`
    byRepo.set(subject, [...(byRepo.get(subject) ?? []), job.id])
  }
  for (const [subject, jobs] of byRepo)
    // oxlint-disable-next-line no-await-in-loop -- one activity entry per repository, in order
    await store.activity.append({
      at,
      actor: 'system',
      action: 'job.new_repo',
      subject,
      details: { jobs },
    })
  return enqueued.length
}
