import type { ScheduleRunList, ScheduleRunResult, ScheduleRunStarted } from '@holtkeeper/api'
import { enqueueUnique, groupRepositories, planSchedule, scheduleRuns } from '@holtkeeper/jobs'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'

import { type Env, type ServerDeps, authorize } from '../context.ts'

const GLOBAL = { kind: 'global' } as const

/** Jobs read per schedule to build its recent runs. */
const RUN_JOBS = 500

/** Recent runs of every schedule and running one by hand. */
export function scheduleRoutes(deps: ServerDeps) {
  const { store, config } = deps
  const app = new Hono<Env>()

  app.get('/schedules/runs', async (c) => {
    authorize(c, 'analyses:read', GLOBAL)
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 10, 1), 50)
    const schedules = config.jobs?.schedules ?? []
    const lists = await Promise.all(
      schedules.map((schedule) => store.jobs.list({ schedule: schedule.name, limit: RUN_JOBS })),
    )
    return c.json<ScheduleRunList>({
      schedules: schedules.map((schedule, index) => ({
        id: schedule.name,
        runs: scheduleRuns(lists[index] ?? [], limit),
      })),
    })
  })

  app.post('/schedules/:id/run', async (c) => {
    const principal = authorize(c, 'analyses:run', GLOBAL)
    const id = c.req.param('id')
    const schedule = config.jobs?.schedules.find((s) => s.name === id)
    if (!schedule) throw new HTTPException(404, { message: `schedule ${id} not found` })
    const startedAt = deps.now().toISOString()
    const run = async (): Promise<ScheduleRunResult> => {
      const requests = await planSchedule(schedule, {
        config,
        analyzers: deps.analyzers ?? [],
        resolveRepos: groupRepositories(config),
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
        store.activity.append({
          at: deps.now().toISOString(),
          actor: principal.id,
          action: 'schedule.run',
          subject: id,
          details: { ...details },
        }),
      )
      .catch((error: unknown) => console.error('schedules: logging a run failed', error))
    deps.onBackground?.(done)
    return c.json<ScheduleRunStarted>({ id, startedAt }, 202)
  })

  return app
}
