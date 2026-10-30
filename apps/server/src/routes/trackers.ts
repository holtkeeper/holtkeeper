import { type PublishResult, publishTracker, trackerDataSchema } from '@holtkeeper/tracker'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import { type Env, type ServerDeps, authorize, readBody } from '../context.ts'

/** Server dependencies the tracker routes read; without `documentSinks` publishing answers 503. */
export type TrackerRouteDeps = ServerDeps

const publishSchema = z
  .object({ outputs: z.array(z.string().min(1)).min(1).optional() })
  .optional()
  .transform((body) => body ?? {})

/** Executes the publications a `tracker` analysis planned. */
export function trackerRoutes(deps: TrackerRouteDeps) {
  const { store } = deps
  const app = new Hono<Env>()

  app.post('/trackers/:analysisId/publish', async (c) => {
    const record = await store.analyses.get(c.req.param('analysisId'))
    if (!record || record.kind !== 'tracker')
      throw new HTTPException(404, { message: 'tracker analysis not found' })
    const principal = authorize(c, 'analyses:run', {
      kind: 'scope',
      scope: { groups: [record.repo.path] },
    })
    const input = await readBody(c, publishSchema)
    const parsed = trackerDataSchema.safeParse(record.data)
    if (!parsed.success)
      throw new HTTPException(409, { message: 'the analysis data is not valid tracker data' })
    if (!deps.documentSinks)
      throw new HTTPException(503, { message: 'no document sinks are configured' })
    const sinks = await deps.documentSinks(record.repo)
    const result = await publishTracker(parsed.data, {
      sinks,
      ...(input.outputs ? { outputs: input.outputs } : {}),
    })
    const subject = `${record.repo.forge}:${record.repo.path}`
    const details = {
      analysis: record.id,
      tracker: parsed.data.tracker.id,
      outcomes: result.outcomes.map(({ output, provider, ref, markerId, status, version }) => ({
        output,
        status,
        ...(provider ? { provider } : {}),
        ...(ref ? { ref } : {}),
        ...(markerId ? { markerId } : {}),
        ...(version === undefined ? {} : { version }),
      })),
    }
    const at = deps.now().toISOString()
    await store.activity.append({
      at,
      actor: principal.id,
      action: 'tracker.published',
      subject,
      details,
    })
    await store.audit?.append({
      at,
      actor: { id: principal.id, name: principal.name, provider: principal.provider },
      via: 'api',
      action: 'tracker.publish',
      target: { type: 'analysis', id: record.id, repo: subject },
      outcome: result.failed ? 'error' : 'ok',
      status: 200,
      details,
    })
    return c.json<PublishResult>(result)
  })

  return app
}
