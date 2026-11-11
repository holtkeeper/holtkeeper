import { weekRange } from '@holtkeeper/ai-usage'
import type { WriteTasksStatus } from '@holtkeeper/api'
import type { RepoRef } from '@holtkeeper/forge'
import {
  type TasksWrite,
  resolveGlobalSetting,
  tasksWrite,
  tasksWriteSchema,
} from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { WRITE_TASK_KIND, type WriteTaskPolicy } from '@holtkeeper/write-task'

import type { ReadOnlyRepos } from './read-only.ts'

/** The `tasks.write` setting with defaults filled in; off when unset or invalid. */
export async function tasksWriteSettings(store: Pick<Store, 'settings'>): Promise<TasksWrite> {
  const entry = resolveGlobalSetting(await store.settings.list(tasksWrite.key), tasksWrite.key)
  const parsed = tasksWriteSchema.safeParse(entry && !entry.secret ? entry.value : {})
  return parsed.success ? parsed.data : tasksWriteSchema.parse({})
}

/**
 * What a write task may do when it starts on a worker: the `tasks.write` switch, the
 * repository's `repo.readOnly` setting, the config's `dryRun`, whether commands run sandboxed and
 * whether this week's spend reached `weeklyUsd`, read anew for every task.
 */
export function writeTaskPolicy(deps: {
  store: Pick<Store, 'settings' | 'aiUsage'>
  readOnly: ReadOnlyRepos
  dryRun: () => boolean
  /** `jobs.execution.mode`; `host` (or unset) runs repository scripts unsandboxed. */
  executionMode: () => string | undefined
  now: () => Date
}): (repo: RepoRef) => Promise<WriteTaskPolicy> {
  return async (repo) => {
    const settings = await tasksWriteSettings(deps.store)
    const mode = deps.executionMode()
    return {
      enabled: settings.enabled,
      readOnly: await deps.readOnly(repo),
      dryRun: deps.dryRun(),
      unsandboxed: mode === undefined || mode === 'host',
      weeklyCapReached: (await weeklyWriteSpend(deps)) >= settings.weeklyUsd,
    }
  }
}

/** What write tasks spent in the current week, in USD. */
export async function weeklyWriteSpend(deps: {
  store: Pick<Store, 'aiUsage'>
  now: () => Date
}): Promise<number> {
  const week = weekRange(deps.now())
  const [spent] = await deps.store.aiUsage.aggregate({
    from: week.from,
    to: week.to,
    filter: { taskKind: WRITE_TASK_KIND },
  })
  return spent?.costUsd ?? 0
}

/**
 * How the write worker pool is doing, from write task jobs: how many wait and run, since when the
 * oldest waits, when a worker last started one and which workers run them now.
 */
export async function writePoolStatus(
  store: Pick<Store, 'jobs'>,
): Promise<WriteTasksStatus['pool']> {
  const [queued, running, recent] = await Promise.all([
    store.jobs.list({ analyzer: WRITE_TASK_KIND, status: 'queued', limit: 500 }),
    store.jobs.list({ analyzer: WRITE_TASK_KIND, status: 'running', limit: 500 }),
    store.jobs.list({ analyzer: WRITE_TASK_KIND, limit: 50 }),
  ])
  const oldest = queued.map((job) => job.createdAt).toSorted()[0]
  const lastStarted = recent
    .flatMap((job) => (job.startedAt ? [job.startedAt] : []))
    .toSorted()
    .at(-1)
  return {
    queued: queued.length,
    running: running.length,
    ...(oldest && { oldestQueuedAt: oldest }),
    ...(lastStarted && { lastStartedAt: lastStarted }),
    workers: [
      ...new Set(running.flatMap((job) => (job.workerId ? [job.workerId] : []))),
    ].toSorted(),
  }
}
