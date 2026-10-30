import type { ScheduleRunList, ScheduleRunResult } from '@holtkeeper/api'
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
    const requests = await planSchedule(schedule, {
      config,
      analyzers: deps.analyzers ?? [],
      resolveRepos: groupRepositories(config),
    })
    const at = deps.now().toISOString()
    const { enqueued, skipped } = await enqueueUnique(
      store.jobs,
      requests.map((request) => ({ ...request, actor: principal.id })),
      at,
    )
    await store.activity.append({
      at,
      actor: principal.id,
      action: 'schedule.run',
      subject: id,
      details: { queued: enqueued.length, skipped: skipped.length },
    })
    return c.json<ScheduleRunResult>({ id, queued: enqueued.length, skipped: skipped.length }, 201)
  })

  return app
}
