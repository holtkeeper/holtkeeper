import { scopeCoversRepo } from '@holtkeeper/access'
import type { SlackChannelView, SlackSettingsView } from '@holtkeeper/api'
import {
  SlackApiError,
  slackCreateAppUrl,
  slackManifest,
  slackRequestUrls,
  slackScopes,
} from '@holtkeeper/chat-slack'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import {
  type AppContext,
  type Env,
  type ServerDeps,
  authorize,
  publicUrlOf,
  readBody,
  repoTarget,
} from '../context.ts'
import {
  SlackConnectionError,
  channelActions,
  slackPolicySchema,
  slackServiceFor,
} from '../slack.ts'

const GLOBAL = { kind: 'global' } as const

const connectSchema = z.object({
  botToken: z.string().trim().min(1),
  signingSecret: z.string().trim().min(1),
})

/**
 * The panel's Slack settings (global `settings:read` to read, `settings:write` to change):
 *
 * - `GET /slack` — where the connection comes from, the workspace and bot, the request URLs and a
 *   manifest for this server (with a link that creates the app from it), the bot scopes and the
 *   channel policy.
 * - `PUT /slack/connection` `{ botToken, signingSecret }` — checks the token with `auth.test`
 *   and stores both sealed; refused while `chat.slack` is in the config file.
 * - `DELETE /slack/connection` — forgets them.
 * - `GET /slack/channels` — public channels and private ones the bot is in, for connecting.
 * - `PUT /slack/policy` — channel bindings (scope, actions, default repository inside the scope)
 *   and what other channels and direct messages may do.
 */
export function slackSettingsRoutes(deps: ServerDeps) {
  const app = new Hono<Env>()
  const slack = slackServiceFor(deps)

  const view = async (c: AppContext): Promise<SlackSettingsView> => {
    const base = publicUrlOf(deps, c)
    const manifest = slackManifest({ baseUrl: base })
    const source = deps.config.chat?.slack
      ? ('file' as const)
      : (await slack.configured())
        ? ('panel' as const)
        : ('none' as const)
    const [workspace, connection, policy] = await Promise.all([
      source === 'none' ? undefined : slack.identity(),
      slack.connection(),
      slack.policy(),
    ])
    return {
      source,
      ...(workspace && { workspace }),
      ...(source === 'panel' && connection && connection),
      urls: slackRequestUrls(base),
      manifest,
      createAppUrl: slackCreateAppUrl(manifest),
      scopes: [...slackScopes],
      policy,
      actions: [...channelActions],
    }
  }

  app.get('/slack', async (c) => {
    authorize(c, 'settings:read', GLOBAL)
    return c.json(await view(c))
  })

  app.put('/slack/connection', async (c) => {
    const principal = authorize(c, 'settings:write', GLOBAL)
    const input = await readBody(c, connectSchema)
    try {
      await slack.connect(input, principal.id)
    } catch (error) {
      if (error instanceof SlackConnectionError)
        throw new HTTPException(400, { message: error.message })
      throw error
    }
    c.set('audit', { action: 'slack.connect', target: { type: 'slack', id: 'connection' } })
    return c.json(await view(c))
  })

  app.delete('/slack/connection', async (c) => {
    authorize(c, 'settings:write', GLOBAL)
    await slack.disconnect()
    c.set('audit', { action: 'slack.disconnect', target: { type: 'slack', id: 'connection' } })
    return c.json(await view(c))
  })

  app.get('/slack/channels', async (c) => {
    authorize(c, 'settings:read', GLOBAL)
    if (!(await slack.configured()))
      throw new HTTPException(409, { message: 'Slack is not connected' })
    try {
      return c.json<{ channels: SlackChannelView[] }>({ channels: await slack.client.channels() })
    } catch (error) {
      if (error instanceof SlackApiError)
        throw new HTTPException(502, {
          message:
            error.code === 'missing_scope'
              ? 'The Slack app lacks channels:read or groups:read; add them and reinstall it'
              : error.message,
        })
      throw error
    }
  })

  app.put('/slack/policy', async (c) => {
    authorize(c, 'settings:write', GLOBAL)
    const policy = await readBody(c, slackPolicySchema)
    const seen = new Set<string>()
    for (const binding of policy.channels) {
      if (seen.has(binding.channel))
        throw new HTTPException(400, { message: `${binding.name} is connected twice` })
      seen.add(binding.channel)
      if (binding.defaultRepo) {
        const separator = binding.defaultRepo.indexOf(':')
        const repo = {
          forge: binding.defaultRepo.slice(0, separator),
          path: binding.defaultRepo.slice(separator + 1),
        }
        if (!scopeCoversRepo(binding.scope, repoTarget(deps.config, repo)))
          throw new HTTPException(400, {
            message: `${binding.name}: the default repository is outside the channel's repositories`,
          })
      }
    }
    await slack.savePolicy(policy)
    c.set('audit', {
      action: 'slack.policy',
      target: { type: 'slack', id: 'policy' },
      details: { channels: policy.channels.length, unbound: policy.unboundChannels },
    })
    return c.json(await view(c))
  })

  return app
}
