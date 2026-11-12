import type { ScheduleRunList, ScheduleRunResult, ScheduleRunStarted } from '@holtkeeper/api'
import {
  enqueueUnique,
  groupRepositories,
  nextRuns,
  planSchedule,
  scheduleRuns,
  systemTimeZone,
} from '@holtkeeper/jobs'
import type { Job } from '@holtkeeper/store'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'

import { appendAudit, auditActorOf } from '../audit.ts'
import { type Env, type ServerDeps, authorize } from '../context.ts'
import { automaticSkip } from '../jobs.ts'
import { knownRepos, queueNewRepoJobs } from '../new-repos.ts'

const GLOBAL = { kind: 'global' } as const

/** Jobs read per schedule on the first try to build its recent runs. */
const RUN_JOBS = 500
/** Jobs read per schedule at most, however few runs that covers. */
const MAX_RUN_JOBS = 32_000
/** Upcoming run times listed per schedule. */
const NEXT_RUNS = 5

/**
 * Recent runs and the next run times of every schedule, running one by hand, and running the new
 * repository trigger on every repository Holtkeeper already knows.
 */
export function scheduleRoutes(deps: ServerDeps) {
  const { store, config } = deps
  const app = new Hono<Env>()

  app.get('/schedules/runs', async (c) => {
    authorize(c, 'analyses:read', GLOBAL)
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 10, 1), 50)
    const schedules = config.jobs.schedules
    const lists = await Promise.all(
      schedules.map((schedule) => runJobs(store, schedule.name, limit)),
    )
    const now = deps.now()
    return c.json<ScheduleRunList>({
      schedules: schedules.map((schedule, index) => ({
        id: schedule.name,
        runs: scheduleRuns(lists[index] ?? [], limit),
        next: schedule.enabled
          ? nextRuns(schedule, now, NEXT_RUNS, {
              timezone: schedule.timezone ?? systemTimeZone(),
            }).map((run) => run.toISOString())
          : [],
      })),
    })
  })

  app.post('/schedules/:id/run', async (c) => {
    const principal = authorize(c, 'analyses:run', GLOBAL)
    const id = c.req.param('id')
    const schedule = config.jobs.schedules.find((s) => s.name === id)
    if (!schedule) throw new HTTPException(404, { message: `schedule ${id} not found` })
    const startedAt = deps.now().toISOString()
    const run = async (): Promise<ScheduleRunResult> => {
      const requests = await planSchedule(schedule, {
        config,
        analyzers: deps.analyzers ?? [],
        resolveRepos: groupRepositories(config),
        skip: automaticSkip(store, config),
      })
      const { enqueued, skipped } = await enqueueUnique(
        store.jobs,
        requests.map((request) => ({ ...request, actor: principal.id })),
        startedAt,
      )
      return { queued: enqueued.length, skipped: skipped.length }
    }
    const done = run()
      .catch((error: unknown): ScheduleRunResult => {
        console.error(`schedules: run of ${id} failed`, error)
        return {
          queued: 0,
          skipped: 0,
          error: error instanceof Error ? error.message : String(error),
        }
      })
      .then((details) =>
        appendAudit(store, {
          at: deps.now().toISOString(),
          actor: auditActorOf(principal, deps.auth.name),
          via: 'job',
          action: 'schedule.run_result',
          target: { type: 'schedule', id },
          outcome: details.error ? 'error' : 'ok',
          details: { ...details },
        }),
      )
    deps.onBackground?.(done)
    return c.json<ScheduleRunStarted>({ id, startedAt }, 202)
  })

  app.post('/triggers/new-repo/run', async (c) => {
    const principal = authorize(c, 'analyses:run', GLOBAL)
    if (!config.jobs?.onNewRepo)
      throw new HTTPException(409, { message: 'the new repository trigger is not configured' })
    const startedAt = deps.now().toISOString()
    const run = async (): Promise<ScheduleRunResult> => {
      const { repos, failed } = await knownRepos(config)
      const result = await queueNewRepoJobs(deps, repos, { actor: principal.id })
      return failed.length ? { ...result, error: `not listed: ${failed.join('; ')}` } : result
    }
    const done = run()
      .catch((error: unknown): ScheduleRunResult => ({
        queued: 0,
        skipped: 0,
        error: error instanceof Error ? error.message : String(error),
      }))
      .then((details) =>
        appendAudit(store, {
          at: deps.now().toISOString(),
          actor: auditActorOf(principal, deps.auth.name),
          via: 'job',
          action: 'trigger.run_result',
          target: { type: 'trigger', id: 'new-repo' },
          outcome: details.error ? 'error' : 'ok',
          details: { ...details },
        }),
      )
    deps.onBackground?.(done)
    return c.json<ScheduleRunStarted>({ id: 'new-repo', startedAt }, 202)
  })

  return app
}

/** The jobs of a schedule's newest `runs` runs, each whole: a run the read cuts off is left out. */
async function runJobs(store: ServerDeps['store'], schedule: string, runs: number): Promise<Job[]> {
  for (let limit = RUN_JOBS; ; limit *= 4) {
    const jobs = await store.jobs.list({ schedule, limit })
    if (jobs.length < limit) return jobs
    const last = jobs.at(-1)?.createdAt
    const whole = jobs.filter((job) => job.createdAt !== last)
    if (new Set(whole.map((job) => job.createdAt)).size >= runs || limit >= MAX_RUN_JOBS)
      return whole
  }
}
