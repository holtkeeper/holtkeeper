import type { DigestList, DigestPreview, DigestRun, DigestView } from '@holtkeeper/api'
import {
  describeSchedule,
  digestInputSchema,
  digestPresets,
  nextDigestRun,
} from '@holtkeeper/digest'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import { type Env, type ServerDeps, authorize, readBody } from '../context.ts'
import { DigestTargetError, digestServiceFor } from '../digests.ts'

const GLOBAL = { kind: 'global' } as const

const attempt = async <T>(work: () => Promise<T>) => {
  try {
    return await work()
  } catch (error) {
    if (error instanceof DigestTargetError) throw new HTTPException(400, { message: error.message })
    throw error
  }
}

/**
 * Digests:
 *
 * - `GET /digests` (`settings:read`) — every digest with its schedule in words, next and last run,
 *   the analysis kinds sections can read, the presets and whether Slack is configured.
 * - `POST /digests`, `PUT /digests/:id`, `DELETE /digests/:id` — `settings:write` over the
 *   digest's scope. A panel target may only be the caller's own chat (or one already there).
 * - `POST /digests/preview` — the card a digest (saved or not) would send now (`analyses:read`
 *   over its scope).
 * - `POST /digests/:id/send` — builds and sends it now, also when empty; the schedule stays.
 */
export function digestRoutes(deps: ServerDeps) {
  const app = new Hono<Env>()
  const digests = digestServiceFor(deps)

  const find = async (id: string) => {
    const digest = (await digests.list()).find((entry) => entry.id === id)
    if (!digest) throw new HTTPException(404, { message: 'no such digest' })
    return digest
  }

  app.get('/digests', async (c) => {
    authorize(c, 'settings:read', GLOBAL)
    const list = await digests.list()
    return c.json<DigestList>({
      digests: await Promise.all(list.map((digest) => digests.view(digest))),
      sources: deps.analyses
        .map((kind) => ({ kind: kind.kind, label: kind.label }))
        .toSorted((a, b) => a.label.localeCompare(b.label)),
      presets: [...digestPresets],
      slack: deps.config.chat?.slack !== undefined,
    })
  })

  app.post('/digests', async (c) => {
    const input = await readBody(c, digestInputSchema)
    const principal = authorize(c, 'settings:write', { kind: 'scope', scope: input.scope })
    const digest = await attempt(() => digests.create(input, principal.id))
    c.set('audit', { action: 'digest.create', target: { type: 'digest', id: digest.id } })
    return c.json<DigestView>(await digests.view(digest), 201)
  })

  app.put('/digests/:id', async (c) => {
    const existing = await find(c.req.param('id'))
    authorize(c, 'settings:write', { kind: 'scope', scope: existing.scope })
    const input = await readBody(c, digestInputSchema)
    const principal = authorize(c, 'settings:write', { kind: 'scope', scope: input.scope })
    const digest = await attempt(() => digests.update(existing.id, input, principal.id))
    if (!digest) throw new HTTPException(404, { message: 'no such digest' })
    c.set('audit', { action: 'digest.update', target: { type: 'digest', id: digest.id } })
    return c.json<DigestView>(await digests.view(digest))
  })

  app.delete('/digests/:id', async (c) => {
    const existing = await find(c.req.param('id'))
    authorize(c, 'settings:write', { kind: 'scope', scope: existing.scope })
    await digests.remove(existing.id)
    c.set('audit', { action: 'digest.delete', target: { type: 'digest', id: existing.id } })
    return c.body(null, 204)
  })

  app.post('/digests/preview', async (c) => {
    const input = await readBody(c, digestInputSchema.extend({ id: z.string().min(1).optional() }))
    authorize(c, 'analyses:read', { kind: 'scope', scope: input.scope })
    const { result, repos } = await digests.build({ ...input, id: input.id ?? 'preview' })
    const next = nextDigestRun(input.schedule, deps.now())
    return c.json<DigestPreview>({
      card: digests.card(input, result),
      items: result.sections.reduce((sum, section) => sum + section.total, 0),
      empty: result.empty,
      repos,
      scheduleText: describeSchedule(input.schedule),
      ...(next && { nextRun: next.toISOString() }),
    })
  })

  app.post('/digests/:id/send', async (c) => {
    const digest = await find(c.req.param('id'))
    authorize(c, 'settings:write', { kind: 'scope', scope: digest.scope })
    const run = await digests.send(digest, true)
    c.set('audit', { action: 'digest.send', target: { type: 'digest', id: digest.id } })
    return c.json<DigestRun>(run)
  })

  return app
}
