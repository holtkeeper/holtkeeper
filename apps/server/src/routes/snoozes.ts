import type { SnoozeList } from '@holtkeeper/api'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import { type Env, type ServerDeps, principalOf, readBody } from '../context.ts'
import { SnoozeConflictError, addSnooze, listSnoozes, removeSnooze } from '../snoozes.ts'

const snoozeSchema = z.object({
  id: z.string().trim().min(1).max(500),
  until: z.iso.datetime({ offset: true }),
})

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof SnoozeConflictError)
      throw new HTTPException(409, { message: error.message })
    throw error
  }
}

/**
 * The caller's personal snoozes (`GET`, `POST`, `DELETE /api/me/snoozes`), kept in `Store.kv`
 * under `snooze:<principal>`. A snooze is a private mark, not a decision, so it is not audited.
 */
export function snoozeRoutes(deps: ServerDeps) {
  const app = new Hono<Env>()

  const kvOf = () => {
    if (!deps.store.kv) throw new HTTPException(503, { message: 'this store keeps no snoozes' })
    return deps.store.kv
  }

  app.get('/me/snoozes', async (c) => {
    const principal = principalOf(c)
    return c.json<SnoozeList>({
      snoozes: await listSnoozes(deps.store.kv, principal.id, deps.now()),
    })
  })

  app.post('/me/snoozes', async (c) => {
    const principal = principalOf(c)
    const input = await readBody(c, snoozeSchema)
    const now = deps.now()
    const until = new Date(input.until)
    if (until.getTime() <= now.getTime())
      throw new HTTPException(400, { message: 'until must be in the future' })
    const kv = kvOf()
    const snoozes = await guarded(() =>
      addSnooze(kv, principal.id, { id: input.id, until: until.toISOString() }, now),
    )
    return c.json<SnoozeList>({ snoozes })
  })

  app.delete('/me/snoozes', async (c) => {
    const principal = principalOf(c)
    const id = c.req.query('id')?.trim()
    if (!id) throw new HTTPException(400, { message: 'id is required' })
    const kv = kvOf()
    const snoozes = await guarded(() => removeSnooze(kv, principal.id, id, deps.now()))
    return c.json<SnoozeList>({ snoozes })
  })

  return app
}
