import { type Form, formCommand, formSchema } from '@holtkeeper/chat'
import { z } from 'zod'

import { COMMAND_ACTION, FORM_ACTION, FORM_VIEW, formValues, formView } from './blocks.ts'
import type { SlackThread } from './surface.ts'

/** What a request from Slack asks for, after its signature was checked. */
export type SlackInbound =
  /** The Events API checks the URL; answer with the challenge. */
  | { kind: 'challenge'; challenge: string }
  /** A command to run: from a slash command, a mention, a direct message or a button. */
  | { kind: 'command'; teamId: string; userId: string; text: string; thread: SlackThread }
  /** A form button was clicked: open the modal with `triggerId` right away. */
  | {
      kind: 'open-form'
      teamId: string
      userId: string
      triggerId: string
      form: Form
      thread: SlackThread
    }
  | { kind: 'ignored'; reason: string }

const ignored = (reason: string): SlackInbound => ({ kind: 'ignored', reason })

/**
 * A slash command (`application/x-www-form-urlencoded`): its text is the command line; an empty
 * text asks for help. Answers go to the channel, or through `response_url` where the bot cannot
 * post.
 */
export function parseSlashCommand(body: URLSearchParams): SlackInbound {
  const teamId = body.get('team_id')
  const userId = body.get('user_id')
  const channel = body.get('channel_id')
  if (!teamId || !userId || !channel) return ignored('incomplete slash command')
  const responseUrl = body.get('response_url')
  return {
    kind: 'command',
    teamId,
    userId,
    text: body.get('text')?.trim() || 'help',
    thread: { channel, ...(responseUrl && { responseUrl }) },
  }
}

const eventSchema = z.object({
  type: z.string(),
  challenge: z.string().optional(),
  team_id: z.string().optional(),
  event: z
    .object({
      type: z.string(),
      user: z.string().optional(),
      text: z.string().optional(),
      channel: z.string().optional(),
      channel_type: z.string().optional(),
      ts: z.string().optional(),
      thread_ts: z.string().optional(),
      bot_id: z.string().optional(),
      subtype: z.string().optional(),
    })
    .optional(),
})

/**
 * An Events API delivery: `app_mention` (the mention is dropped, the answer goes to the thread of
 * the mention) and `message` in direct messages (`channel_type: im`). Messages of bots, edits and
 * other subtypes are ignored, so the bot never answers itself.
 */
export function parseEvent(json: unknown): SlackInbound {
  const parsed = eventSchema.safeParse(json)
  if (!parsed.success) return ignored('not an event')
  const { type, challenge, team_id: teamId, event } = parsed.data
  if (type === 'url_verification' && challenge) return { kind: 'challenge', challenge }
  if (type !== 'event_callback' || !event || !teamId) return ignored(`event ${type}`)
  if (event.bot_id || event.subtype) return ignored('bot message or subtype')
  if (!event.user || !event.channel || !event.ts) return ignored('incomplete event')
  const text = (event.text ?? '').replaceAll(/<@[A-Z0-9]+>/g, '').trim() || 'help'
  if (event.type === 'app_mention')
    return {
      kind: 'command',
      teamId,
      userId: event.user,
      text,
      thread: { channel: event.channel, threadTs: event.thread_ts ?? event.ts },
    }
  if (event.type === 'message' && event.channel_type === 'im')
    return {
      kind: 'command',
      teamId,
      userId: event.user,
      text,
      thread: { channel: event.channel, ...(event.thread_ts && { threadTs: event.thread_ts }) },
    }
  return ignored(`event ${event.type}`)
}

const threadSchema = z.object({
  channel: z.string(),
  threadTs: z.string().optional(),
  responseUrl: z.string().optional(),
})

const formMetadataSchema = z.object({ form: formSchema, thread: threadSchema })

/** The modal of a form; its submission comes back to `thread`. */
export const formModal = (form: Form, thread: SlackThread) =>
  formView(form, JSON.stringify({ form, thread }))

const stateValueSchema = z.object({
  value: z.string().nullable().optional(),
  selected_option: z.object({ value: z.string() }).nullable().optional(),
  selected_options: z.array(z.object({ value: z.string() })).optional(),
})

const interactionSchema = z.object({
  type: z.string(),
  trigger_id: z.string().optional(),
  team: z.object({ id: z.string() }).nullable().optional(),
  user: z.object({ id: z.string(), team_id: z.string().optional() }),
  channel: z.object({ id: z.string() }).nullable().optional(),
  container: z.object({ thread_ts: z.string().optional() }).optional(),
  message: z.object({ ts: z.string(), thread_ts: z.string().optional() }).optional(),
  response_url: z.string().optional(),
  actions: z.array(z.object({ action_id: z.string(), value: z.string().optional() })).optional(),
  view: z
    .object({
      callback_id: z.string(),
      private_metadata: z.string().optional(),
      state: z.object({ values: z.record(z.string(), z.record(z.string(), stateValueSchema)) }),
    })
    .optional(),
})

const parseJson = (text: string | undefined): unknown => {
  try {
    return text === undefined ? undefined : JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * An interaction (`payload=` JSON): a command button runs its value in the thread of the message;
 * a form button asks to open its modal; a submitted form modal runs `formCommand` of its values in
 * the thread the form came from. Link buttons and anything else are ignored.
 */
export function parseInteraction(body: URLSearchParams): SlackInbound {
  const parsed = interactionSchema.safeParse(parseJson(body.get('payload') ?? undefined))
  if (!parsed.success) return ignored('not an interaction')
  const payload = parsed.data
  const teamId = payload.team?.id ?? payload.user.team_id
  if (!teamId) return ignored('no team')
  const userId = payload.user.id

  if (payload.type === 'block_actions') {
    const action = payload.actions?.[0]
    const channel = payload.channel?.id
    if (!action || !channel) return ignored('no action')
    const thread: SlackThread = {
      channel,
      ...((payload.message?.thread_ts ?? payload.message?.ts) && {
        threadTs: payload.message?.thread_ts ?? payload.message?.ts,
      }),
      ...(payload.response_url && { responseUrl: payload.response_url }),
    }
    if (action.action_id.startsWith(COMMAND_ACTION) && action.value)
      return { kind: 'command', teamId, userId, text: action.value, thread }
    if (action.action_id === FORM_ACTION && action.value && payload.trigger_id) {
      const form = formSchema.safeParse(parseJson(action.value))
      if (!form.success) return ignored('invalid form')
      return {
        kind: 'open-form',
        teamId,
        userId,
        triggerId: payload.trigger_id,
        form: form.data,
        thread,
      }
    }
    return ignored(`action ${action.action_id}`)
  }

  if (payload.type === 'view_submission' && payload.view?.callback_id === FORM_VIEW) {
    const metadata = formMetadataSchema.safeParse(parseJson(payload.view.private_metadata))
    if (!metadata.success) return ignored('invalid form metadata')
    const { form, thread } = metadata.data
    const text = formCommand(form, formValues(form, payload.view.state.values))
    return {
      kind: 'command',
      teamId,
      userId,
      text,
      thread: {
        channel: thread.channel,
        ...(thread.threadTs && { threadTs: thread.threadTs }),
        ...(thread.responseUrl && { responseUrl: thread.responseUrl }),
      },
    }
  }

  return ignored(`interaction ${payload.type}`)
}
