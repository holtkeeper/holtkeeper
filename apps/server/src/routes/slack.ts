import { textCard } from '@holtkeeper/chat'
import {
  type SlackInbound,
  formModal,
  parseEvent,
  parseInteraction,
  parseSlashCommand,
  verifySlackRequest,
} from '@holtkeeper/chat-slack'
import { slackProvider } from '@holtkeeper/identities'
import { Hono } from 'hono'

import { type ChatLimit, chatFor } from '../chat.ts'
import type { Env, ServerDeps } from '../context.ts'
import { slackServiceFor } from '../slack.ts'

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const parseRepoKey = (key: string) => {
  const separator = key.indexOf(':')
  return { forge: key.slice(0, separator), path: key.slice(separator + 1) }
}

/**
 * The Slack app's request URLs: `POST /chat/slack/events` (Events API), `/chat/slack/commands`
 * (the `/holtkeeper` slash command) and `/chat/slack/interactions` (buttons and modals). Each
 * answers 404 while Slack is not connected (neither `chat.slack` nor the panel) and 401 without a
 * valid Slack signature.
 *
 * Where a command runs decides what it reaches: in a connected channel the channel's scope and
 * actions narrow the person's grants and its default repository is the conversation's; in direct
 * messages the person's grants apply when the policy allows them; other channels are refused or
 * use the person's grants, as the policy says.
 *
 * Slack wants an answer within three seconds, so commands run after the answer (through
 * `deps.onBackground` when given) and reply with new messages; form buttons open their modal
 * before answering, since the trigger expires. Redelivered events (`X-Slack-Retry-Num`) are
 * acknowledged and dropped, so a slow first delivery never runs a command twice.
 */
export function slackRoutes(deps: ServerDeps) {
  const app = new Hono<Env>()
  const slack = slackServiceFor(deps)

  const answer = async (inbound: Extract<SlackInbound, { kind: 'command' }>) => {
    const chat = chatFor(deps)
    const surface = chat.surface('slack')
    if (!surface) return
    const policy = await slack.policy()
    const { channel } = inbound.thread
    const direct = channel.startsWith('D')
    const binding = policy.channels.find((entry) => entry.channel === channel)
    const refuse = (text: string) =>
      surface.post({ ...inbound.thread }, textCard('', text, 'warning'))

    if (direct && !policy.directMessages) {
      await refuse(
        'Commands in direct messages are off on this Holtkeeper. Use a connected channel.',
      )
      return
    }
    if (!direct && !binding && policy.unboundChannels === 'deny') {
      await refuse(
        `This channel is not connected to Holtkeeper. An admin can connect it under **Slack** in the panel (channel id \`${channel}\`).`,
      )
      return
    }
    const limit: ChatLimit | undefined = binding
      ? { scope: binding.scope, actions: binding.actions }
      : undefined
    const router = chat.router([], limit ? { limit } : {})
    await router.handle(
      {
        surface: surface.id,
        thread: { ...inbound.thread },
        actor: { provider: slackProvider(inbound.teamId), externalId: inbound.userId },
        text: inbound.text,
        ...(binding?.defaultRepo && { repo: parseRepoKey(binding.defaultRepo) }),
      },
      surface,
      router.parse(inbound.text, true),
    )
  }

  const run = (inbound: Extract<SlackInbound, { kind: 'command' }>) => {
    const work = answer(inbound).catch((error: unknown) =>
      console.error(`slack: answering failed: ${messageOf(error)}`),
    )
    if (deps.onBackground) deps.onBackground(work)
  }

  const receive = (path: string, parse: (body: string) => SlackInbound) =>
    app.post(path, async (c) => {
      const secrets = await slack.secrets()
      if (!secrets) return c.json({ error: 'Slack is not connected' }, 404)
      const body = await c.req.text()
      const signed = verifySlackRequest({
        signingSecret: secrets.signingSecret,
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
          await slack.client.openView(inbound.triggerId, formModal(inbound.form, inbound.thread))
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
