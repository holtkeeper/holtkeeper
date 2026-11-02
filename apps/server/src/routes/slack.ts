import {
  type SlackInbound,
  formModal,
  parseEvent,
  parseInteraction,
  parseSlashCommand,
  slackClient,
  verifySlackRequest,
} from '@holtkeeper/chat-slack'
import { resolveSecret } from '@holtkeeper/forge'
import { slackProvider } from '@holtkeeper/identities'
import { Hono } from 'hono'

import { chatFor } from '../chat.ts'
import type { Env, ServerDeps } from '../context.ts'

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * The Slack app's request URLs: `POST /chat/slack/events` (Events API), `/chat/slack/commands`
 * (the `/holtkeeper` slash command) and `/chat/slack/interactions` (buttons and modals). Each
 * answers 404 while `chat.slack` is not configured and 401 without a valid Slack signature.
 *
 * Slack wants an answer within three seconds, so commands run after the answer (through
 * `deps.onBackground` when given) and reply with new messages; form buttons open their modal
 * before answering, since the trigger expires. Redelivered events (`X-Slack-Retry-Num`) are
 * acknowledged and dropped, so a slow first delivery never runs a command twice.
 */
export function slackRoutes(deps: ServerDeps) {
  const app = new Hono<Env>()

  const run = (inbound: Extract<SlackInbound, { kind: 'command' }>) => {
    const chat = chatFor(deps)
    const surface = chat.surface('slack')
    if (!surface) return
    const router = chat.router()
    const line = router.parse(inbound.text, true)
    const work = router
      .handle(
        {
          surface: surface.id,
          thread: { ...inbound.thread },
          actor: { provider: slackProvider(inbound.teamId), externalId: inbound.userId },
          text: inbound.text,
        },
        surface,
        line,
      )
      .catch((error: unknown) => console.error(`slack: answering failed: ${messageOf(error)}`))
    if (deps.onBackground) deps.onBackground(work)
  }

  const receive = (path: string, parse: (body: string) => SlackInbound) =>
    app.post(path, async (c) => {
      const slack = deps.config.chat?.slack
      if (!slack) return c.json({ error: 'Slack is not configured' }, 404)
      const body = await c.req.text()
      const signed = verifySlackRequest({
        signingSecret: resolveSecret(slack.signingSecret),
        timestamp: c.req.header('x-slack-request-timestamp'),
        signature: c.req.header('x-slack-signature'),
        body,
        now: deps.now(),
      })
      if (!signed) return c.json({ error: 'invalid Slack signature' }, 401)
      if (c.req.header('x-slack-retry-num')) return c.body(null, 200)

      const inbound = parse(body)
      if (inbound.kind === 'challenge') return c.json({ challenge: inbound.challenge })
      if (inbound.kind === 'open-form') {
        try {
          await slackClient({
            token: slack.botToken,
            ...(deps.slackFetch && { fetch: deps.slackFetch }),
          }).openView(inbound.triggerId, formModal(inbound.form, inbound.thread))
        } catch (error) {
          console.error(`slack: opening a form failed: ${messageOf(error)}`)
        }
        return c.body(null, 200)
      }
      if (inbound.kind === 'command') run(inbound)
      return c.body(null, 200)
    })

  receive('/chat/slack/events', (body) => {
    try {
      return parseEvent(JSON.parse(body))
    } catch {
      return { kind: 'ignored', reason: 'not JSON' }
    }
  })
  receive('/chat/slack/commands', (body) => parseSlashCommand(new URLSearchParams(body)))
  receive('/chat/slack/interactions', (body) => parseInteraction(new URLSearchParams(body)))

  return app
}
