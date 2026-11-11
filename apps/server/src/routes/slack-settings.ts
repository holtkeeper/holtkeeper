import type { SlackSettingsView } from '@holtkeeper/api'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import { type Env, type ServerDeps, authorize, readBody } from '../context.ts'

const CONNECTION_KEY = 'chat:slack:connection'
const GLOBAL = { kind: 'global' } as const

const connectSchema = z.object({
  botToken: z.string().trim().min(1),
  signingSecret: z.string().trim().min(1),
})

const storedSchema = z.object({
  botToken: z.string(),
  signingSecret: z.string(),
  connectedAt: z.string(),
  connectedBy: z.string(),
})

/**
 * Slack app tokens kept for a future integration (global `settings:read` to read,
 * `settings:write` to change). Nothing talks to Slack; the tokens are only stored, sealed with
 * the vault in `store.kv` under `chat:slack:connection`.
 *
 * - `GET /slack` — whether tokens are stored, when and by whom.
 * - `PUT /slack/connection` `{ botToken, signingSecret }` — stores both sealed.
 * - `DELETE /slack/connection` — forgets them.
 */
export function slackSettingsRoutes(deps: ServerDeps) {
  const app = new Hono<Env>()

  const kvOf = () => {
    if (!deps.store.kv) throw new HTTPException(503, { message: 'this server keeps no settings' })
    return deps.store.kv
  }

  const view = async (): Promise<SlackSettingsView> => {
    const parsed = storedSchema.safeParse(await deps.store.kv?.get(CONNECTION_KEY))
    return parsed.success
      ? {
          configured: true,
          connectedAt: parsed.data.connectedAt,
          connectedBy: parsed.data.connectedBy,
        }
      : { configured: false }
  }

  app.get('/slack', async (c) => {
    authorize(c, 'settings:read', GLOBAL)
    return c.json(await view())
  })

  app.put('/slack/connection', async (c) => {
    const principal = authorize(c, 'settings:write', GLOBAL)
    const input = await readBody(c, connectSchema)
    if (!input.botToken.startsWith('xoxb-'))
      throw new HTTPException(400, {
        message: 'The bot token starts with xoxb- (Bot User OAuth Token)',
      })
    await kvOf().set(CONNECTION_KEY, {
      botToken: await deps.vault.seal(input.botToken),
      signingSecret: await deps.vault.seal(input.signingSecret),
      connectedAt: deps.now().toISOString(),
      connectedBy: principal.id,
    })
    c.set('audit', { action: 'slack.connect', target: { type: 'slack', id: 'connection' } })
    return c.json(await view())
  })

  app.delete('/slack/connection', async (c) => {
    authorize(c, 'settings:write', GLOBAL)
    await kvOf().delete(CONNECTION_KEY)
    c.set('audit', { action: 'slack.disconnect', target: { type: 'slack', id: 'connection' } })
    return c.json(await view())
  })

  return app
}
