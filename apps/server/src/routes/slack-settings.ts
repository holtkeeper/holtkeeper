import type { SlackSettingsView } from '@holtkeeper/api'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import { type Env, type ServerDeps, authorize, readBody } from '../context.ts'
import {
  SLACK_CONNECTION_KEY,
  type StoredSlackConnection,
  defaultSlackEmoji,
  fallbackSlackEmoji,
  slackEmojiOverridesSchema,
  storedSlackConnection,
} from '../slack/connection.ts'

const GLOBAL = { kind: 'global' } as const

/** Path of the Slack Events API request URL. */
const SLACK_EVENTS_PATH = '/api/slack/events'

const connectSchema = z.object({
  botToken: z.string().trim().min(1),
  signingSecret: z.string().trim().min(1),
  emoji: slackEmojiOverridesSchema.optional(),
})

const emojiSchema = z.object({ emoji: slackEmojiOverridesSchema })

/**
 * The Slack app credential, one per instance (global `settings:read` to read, `settings:write`
 * to change): bot token and signing secret sealed with the vault in `store.kv` under
 * `chat:slack:connection`, and the review status emoji overrides.
 *
 * - `GET /slack` — whether the credential is stored, when and by whom, and the emoji.
 * - `PUT /slack/connection` `{ botToken, signingSecret, emoji? }` — stores both sealed; without
 *   `emoji` the stored overrides stay.
 * - `PUT /slack/emoji` `{ emoji }` — replaces the emoji overrides; 409 without a credential.
 * - `DELETE /slack/connection` — forgets the credential with its emoji.
 */
export function slackSettingsRoutes(deps: ServerDeps) {
  const app = new Hono<Env>()

  const kvOf = () => {
    if (!deps.store.kv) throw new HTTPException(503, { message: 'this server keeps no settings' })
    return deps.store.kv
  }

  const view = async (): Promise<SlackSettingsView> => {
    const stored = await storedSlackConnection(deps.store)
    const common = {
      defaultEmoji: { ...defaultSlackEmoji },
      fallbackEmoji: { ...fallbackSlackEmoji },
      eventsPath: SLACK_EVENTS_PATH,
    }
    return stored
      ? {
          configured: true,
          connectedAt: stored.connectedAt,
          connectedBy: stored.connectedBy,
          emoji: stored.emoji ?? {},
          ...common,
        }
      : { configured: false, emoji: {}, ...common }
  }

  const save = ({ emoji, ...rest }: StoredSlackConnection) =>
    kvOf().set(
      SLACK_CONNECTION_KEY,
      emoji && Object.keys(emoji).length > 0 ? { ...rest, emoji } : rest,
    )

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
    const emoji = input.emoji ?? (await storedSlackConnection(deps.store))?.emoji
    await save({
      botToken: await deps.vault.seal(input.botToken),
      signingSecret: await deps.vault.seal(input.signingSecret),
      connectedAt: deps.now().toISOString(),
      connectedBy: principal.id,
      ...(emoji && { emoji }),
    })
    c.set('audit', { action: 'slack.connect', target: { type: 'slack', id: 'connection' } })
    return c.json(await view())
  })

  app.put('/slack/emoji', async (c) => {
    authorize(c, 'settings:write', GLOBAL)
    const input = await readBody(c, emojiSchema)
    const stored = await storedSlackConnection(deps.store)
    if (!stored)
      throw new HTTPException(409, {
        message: 'Store the Slack bot token and signing secret first',
      })
    await save({ ...stored, emoji: input.emoji })
    c.set('audit', {
      action: 'slack.emoji',
      target: { type: 'slack', id: 'connection' },
      details: { emoji: input.emoji },
    })
    return c.json(await view())
  })

  app.delete('/slack/connection', async (c) => {
    authorize(c, 'settings:write', GLOBAL)
    await kvOf().delete(SLACK_CONNECTION_KEY)
    c.set('audit', { action: 'slack.disconnect', target: { type: 'slack', id: 'connection' } })
    return c.json(await view())
  })

  return app
}
