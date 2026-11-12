import type { InboxCount, InboxFeed } from '@holtkeeper/api'
import { Hono } from 'hono'

import { type Env, type ServerDeps, principalOf } from '../context.ts'
import { inboxServiceFor } from '../inbox.ts'

/**
 * `GET /api/inbox`: the decisions the caller may make, in `mine` and `teams`. `GET
 * /api/inbox/count`: their numbers without snoozed items, with an ETag (304 on `If-None-Match`).
 * Both read stored data only. Decisions are made through each kind's own endpoint.
 */
export function inboxRoutes(deps: ServerDeps) {
  const app = new Hono<Env>()
  const inbox = inboxServiceFor(deps)

  app.get('/inbox', async (c) => c.json<InboxFeed>(await inbox.feed(principalOf(c))))

  app.get('/inbox/count', async (c) => {
    const count = await inbox.count(principalOf(c))
    const etag = `"inbox-${count.mine}-${count.teams}"`
    c.header('ETag', etag)
    c.header('Cache-Control', 'private, no-cache')
    const sent = c.req.header('if-none-match')
    if (sent?.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag))
      return c.body(null, 304)
    return c.json<InboxCount>(count)
  })

  return app
}
