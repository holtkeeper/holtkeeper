import type { QaSummaryView, QaTaskList, QaTaskView } from '@holtkeeper/api'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import {
  type Env,
  type ServerDeps,
  ForbiddenException,
  principalOf,
  readBody,
  repoKey,
  repoTarget,
} from '../context.ts'
import { QaSummaryError, QaTaskNotFoundError, qaPeriods, qaServiceFor } from '../qa.ts'
import { canSee } from '../visibility.ts'

const keySchema = z.string().trim().min(1).max(100)
const summarySchema = z.object({ key: keySchema })

const notFound = (error: unknown): never => {
  if (error instanceof QaTaskNotFoundError) throw new HTTPException(404, { message: error.message })
  if (error instanceof QaSummaryError) throw new HTTPException(409, { message: error.message })
  throw error
}

/**
 * Releases › QA: tasks (ticket keys) with the changes that name them in the repositories the
 * caller may read releases of, one task with the files and test attributes of its changes, and
 * an AI summary written on request. Reading needs `releases:read`; a summary needs
 * `analyses:run` on the repository of the task's newest change.
 */
export function qaRoutes(deps: ServerDeps) {
  const { config } = deps
  const app = new Hono<Env>()
  const qa = qaServiceFor(deps)

  app.get('/qa/tasks', async (c) => {
    const days = qaPeriods.find((period) => String(period) === (c.req.query('days') ?? '30'))
    if (days === undefined)
      throw new HTTPException(400, { message: `days is one of ${qaPeriods.join(', ')}` })
    const team = c.req.query('team')
    if (team && !config.teams[team])
      throw new HTTPException(400, { message: `unknown team ${team}` })
    return c.json<QaTaskList>(await qa.tasks(principalOf(c), { days, ...(team ? { team } : {}) }))
  })

  app.get('/qa/task', async (c) => {
    const parsed = keySchema.safeParse(c.req.query('key'))
    if (!parsed.success) throw new HTTPException(400, { message: 'key is required' })
    return c.json<QaTaskView>(await qa.task(principalOf(c), parsed.data).catch(notFound))
  })

  app.post('/qa/summary', async (c) => {
    const { key } = await readBody(c, summarySchema)
    const principal = principalOf(c)
    const repo = await qa.summaryRepo(principal, key)
    if (!repo) throw new HTTPException(404, { message: `no changes name ${key}` })
    if (!canSee(principal, 'analyses:run', repoTarget(config, repo)))
      throw new ForbiddenException('analyses:run', repoKey(repo))
    return c.json<QaSummaryView>(await qa.summarize(principal, key).catch(notFound))
  })

  return app
}
