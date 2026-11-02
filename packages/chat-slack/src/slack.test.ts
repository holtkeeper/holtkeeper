import { describe, expect, test } from 'bun:test'

import type { Card, Form } from '@holtkeeper/chat'

import { COMMAND_ACTION, FORM_ACTION, formValues, formView, renderSlackMessage } from './blocks.ts'
import { SlackApiError, type SlackFetch, slackClient } from './client.ts'
import { formModal, parseEvent, parseInteraction, parseSlashCommand } from './inbound.ts'
import { signSlackRequest, verifySlackRequest } from './signature.ts'
import { slackSurface } from './surface.ts'

const form: Form = {
  command: 'release deploy',
  submitLabel: 'Deploy',
  fields: [
    {
      kind: 'select',
      name: 'environment',
      label: 'Environment',
      options: [
        { value: 'qa', label: 'QA' },
        { value: 'prod', label: 'Production' },
      ],
      initial: 'qa',
    },
    {
      kind: 'select',
      name: 'repos',
      label: 'Repositories',
      options: [{ value: 'a', label: 'A' }],
      multiple: true,
    },
    { kind: 'text', name: 'note', label: 'Note', optional: true, multiline: true },
    { kind: 'toggle', name: 'force', label: 'Ignore gates' },
  ],
}

function fakeSlack(answers: Record<string, unknown> = {}) {
  const calls: { url: string; body: Record<string, unknown>; auth: string | null }[] = []
  let ts = 0
  const fetch: SlackFetch = async (url, init) => {
    const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Record<
      string,
      unknown
    >
    calls.push({ url, body, auth: new Headers(init.headers).get('authorization') })
    const method = url.split('/').at(-1) ?? ''
    if (method in answers) return Response.json(answers[method])
    return Response.json({ ok: true, channel: body['channel'], ts: `1700000000.00000${++ts}` })
  }
  return { fetch, calls, client: slackClient({ token: 'xoxb-secret', fetch }) }
}

describe('signature', () => {
  const now = new Date('2026-11-02T10:00:00Z')
  const timestamp = String(now.getTime() / 1000)
  const body = 'token=x&text=release'

  test('accepts Slack signatures and refuses tampering and old requests', () => {
    const signature = signSlackRequest('shh', timestamp, body)
    expect(verifySlackRequest({ signingSecret: 'shh', timestamp, signature, body, now })).toBe(true)
    expect(
      verifySlackRequest({ signingSecret: 'shh', timestamp, signature, body: `${body}x`, now }),
    ).toBe(false)
    expect(verifySlackRequest({ signingSecret: 'other', timestamp, signature, body, now })).toBe(
      false,
    )
    const old = String(now.getTime() / 1000 - 301)
    expect(
      verifySlackRequest({
        signingSecret: 'shh',
        timestamp: old,
        signature: signSlackRequest('shh', old, body),
        body,
        now,
      }),
    ).toBe(false)
    expect(
      verifySlackRequest({ signingSecret: 'shh', timestamp, signature: undefined, body, now }),
    ).toBe(false)
  })
})

describe('blocks', () => {
  const card: Card = {
    title: 'Release games/app-x',
    tone: 'warning',
    url: 'https://holt.example/release-board/repo?repo=work%3Agames%2Fapp-x',
    blocks: [
      { type: 'text', text: 'Hi <!channel> **now**' },
      { type: 'fields', fields: [{ label: 'Next', value: '`1.3.0`' }] },
      {
        type: 'steps',
        steps: [
          { label: 'qa', status: 'done', url: 'https://ci.example/1' },
          { label: 'prod', status: 'running', detail: 'deploying' },
        ],
      },
      { type: 'list', items: [{ text: 'pipeline failed', tone: 'bad' }] },
      {
        type: 'actions',
        actions: [
          { label: 'Create v1.3.0', command: 'release version', style: 'primary' },
          { label: 'Deploy', command: 'release deploy prod --yes', style: 'danger' },
        ],
      },
      { type: 'form', form },
      { type: 'context', text: 'dry run' },
    ],
  }

  test('renders every block, escapes text and carries commands in buttons', () => {
    const { text, blocks } = renderSlackMessage(card)
    expect(text).toBe('Release games/app-x')
    expect(blocks.map((block) => block['type'])).toEqual([
      'header',
      'section',
      'section',
      'section',
      'section',
      'section',
      'actions',
      'actions',
      'context',
      'actions',
    ])
    expect(blocks[0]).toEqual({
      type: 'header',
      text: { type: 'plain_text', text: '🟠 Release games/app-x', emoji: true },
    })
    expect(JSON.stringify(blocks[1])).toContain('Hi &lt;!channel&gt; *now*')
    expect(blocks[3]).toMatchObject({
      text: { text: '✅  *qa*' },
      accessory: { type: 'button', text: { text: 'Open' }, url: 'https://ci.example/1' },
    })
    expect(blocks[4]).toEqual({
      type: 'section',
      text: { type: 'mrkdwn', text: '🔄  *prod*  —  deploying' },
    })
    const [create, deploy] = (blocks[6]?.['elements'] ?? []) as Record<string, unknown>[]
    expect(create).toMatchObject({
      action_id: `${COMMAND_ACTION}:0`,
      value: 'release version',
      style: 'primary',
    })
    expect(create?.['confirm']).toBeUndefined()
    expect(deploy).toMatchObject({ value: 'release deploy prod --yes', style: 'danger' })
    expect(deploy?.['confirm']).toBeDefined()
    const [open] = (blocks[7]?.['elements'] ?? []) as Record<string, unknown>[]
    expect(open).toMatchObject({ action_id: FORM_ACTION })
    expect(JSON.parse(String(open?.['value']))).toEqual(form)
    expect(JSON.stringify(blocks[9])).toContain(card.url ?? '')
  })

  test('subtitles, headings, dividers, flows and the link beside the buttons', () => {
    const { blocks } = renderSlackMessage({
      title: 'Release · games/app-x',
      subtitle: 'Merged changes wait for a version',
      url: 'https://holt.example/r',
      blocks: [
        {
          type: 'steps',
          layout: 'flow',
          steps: [
            { label: 'Changes', status: 'done' },
            { label: 'Version', status: 'active' },
            { label: 'Deploy', status: 'pending' },
          ],
        },
        { type: 'heading', text: 'Gates', detail: '1 failing', tone: 'bad' },
        { type: 'divider' },
        { type: 'actions', actions: [{ label: 'Create v1.3.0', command: 'release version' }] },
      ],
    })
    expect(blocks.map((block) => block['type'])).toEqual([
      'header',
      'context',
      'context',
      'section',
      'divider',
      'actions',
    ])
    expect(JSON.stringify(blocks[1])).toContain('Merged changes wait for a version')
    expect(JSON.stringify(blocks[2])).toContain('✅ Changes   →   🔵 Version   →   ⚪ Deploy')
    expect(JSON.stringify(blocks[3])).toContain('🔴 *Gates*   ·   1 failing')
    expect(blocks[5]?.['elements']).toHaveLength(2)
  })

  test('forms become modals and their state becomes values', () => {
    const view = formView(form, '{}')
    expect(view.blocks.map((block) => (block['element'] as { type: string }).type)).toEqual([
      'static_select',
      'multi_static_select',
      'plain_text_input',
      'checkboxes',
    ])
    expect(view.blocks[0]).toMatchObject({ element: { initial_option: { value: 'qa' } } })
    expect(
      formValues(form, {
        environment: { value: { selected_option: { value: 'prod' } } },
        repos: { value: { selected_options: [{ value: 'a' }] } },
        note: { value: { value: null } },
        force: { value: { selected_options: [] } },
      }),
    ).toEqual({ environment: 'prod', repos: ['a'], note: undefined, force: false })
  })
})

const event = (extra: Record<string, unknown>) => ({
  type: 'event_callback',
  team_id: 'T1',
  event: { user: 'U1', channel: 'C1', ts: '1.1', ...extra },
})
const payload = (value: unknown) => new URLSearchParams({ payload: JSON.stringify(value) })

describe('inbound', () => {
  test('slash commands carry their text and response url', () => {
    const body = new URLSearchParams({
      team_id: 'T1',
      user_id: 'U1',
      channel_id: 'C1',
      text: 'release repo=work:games/app-x',
      response_url: 'https://hooks.slack.com/commands/1',
    })
    expect(parseSlashCommand(body)).toEqual({
      kind: 'command',
      teamId: 'T1',
      userId: 'U1',
      text: 'release repo=work:games/app-x',
      thread: { channel: 'C1', responseUrl: 'https://hooks.slack.com/commands/1' },
    })
    body.set('text', ' ')
    expect(parseSlashCommand(body)).toMatchObject({ text: 'help' })
  })

  test('mentions and direct messages, never bots', () => {
    expect(parseEvent({ type: 'url_verification', challenge: 'abc' })).toEqual({
      kind: 'challenge',
      challenge: 'abc',
    })
    expect(parseEvent(event({ type: 'app_mention', text: '<@UBOT> release' }))).toEqual({
      kind: 'command',
      teamId: 'T1',
      userId: 'U1',
      text: 'release',
      thread: { channel: 'C1', threadTs: '1.1' },
    })
    expect(parseEvent(event({ type: 'message', channel_type: 'im', text: 'help' }))).toMatchObject({
      thread: { channel: 'C1' },
    })
    expect(parseEvent(event({ type: 'message', channel_type: 'im', bot_id: 'B1' })).kind).toBe(
      'ignored',
    )
    expect(parseEvent(event({ type: 'message', channel_type: 'channel' })).kind).toBe('ignored')
  })

  test('buttons run commands in the thread, forms open and submit', () => {
    const click = (actionId: string, value: string) =>
      payload({
        type: 'block_actions',
        trigger_id: 'trig',
        team: { id: 'T1' },
        user: { id: 'U1' },
        channel: { id: 'C1' },
        message: { ts: '2.2' },
        actions: [{ action_id: actionId, value }],
      })
    expect(parseInteraction(click(`${COMMAND_ACTION}:1`, 'release version --yes'))).toEqual({
      kind: 'command',
      teamId: 'T1',
      userId: 'U1',
      text: 'release version --yes',
      thread: { channel: 'C1', threadTs: '2.2' },
    })
    const opened = parseInteraction(click(FORM_ACTION, JSON.stringify(form)))
    expect(opened).toMatchObject({ kind: 'open-form', triggerId: 'trig', form })
    expect(parseInteraction(click(FORM_ACTION, '{"command":1}')).kind).toBe('ignored')

    const view = formModal(form, { channel: 'C1', threadTs: '2.2' })
    expect(
      parseInteraction(
        payload({
          type: 'view_submission',
          team: { id: 'T1' },
          user: { id: 'U1' },
          view: {
            callback_id: view.callback_id,
            private_metadata: view.private_metadata,
            state: {
              values: {
                environment: { value: { selected_option: { value: 'prod' } } },
                repos: { value: { selected_options: [] } },
                note: { value: { value: 'after lunch' } },
                force: { value: { selected_options: [{ value: 'true' }] } },
              },
            },
          },
        }),
      ),
    ).toEqual({
      kind: 'command',
      teamId: 'T1',
      userId: 'U1',
      text: 'release deploy environment=prod note="after lunch" force=true',
      thread: { channel: 'C1', threadTs: '2.2' },
    })
  })
})

describe('client and surface', () => {
  test('posts in threads, updates in place and sends the bot token', async () => {
    const { client, calls } = fakeSlack()
    const surface = slackSurface({ client })
    const posted = await surface.post(
      { channel: 'C1', threadTs: '2.2' },
      { title: 'Deploying', blocks: [] },
    )
    expect(posted.id).toBe('C1/1700000000.000001')
    expect(calls[0]).toMatchObject({
      url: 'https://slack.com/api/chat.postMessage',
      body: { channel: 'C1', thread_ts: '2.2', text: 'Deploying' },
      auth: 'Bearer xoxb-secret',
    })
    await surface.update?.(posted, { title: 'Deployed', blocks: [] })
    expect(calls[1]).toMatchObject({
      url: 'https://slack.com/api/chat.update',
      body: { channel: 'C1', ts: '1700000000.000001', text: 'Deployed' },
    })
  })

  test('answers privately where the bot was not invited', async () => {
    const { client, calls } = fakeSlack({
      'chat.postMessage': { ok: false, error: 'not_in_channel' },
    })
    const surface = slackSurface({ client })
    const posted = await surface.post(
      { channel: 'C1', responseUrl: 'https://hooks.slack.com/commands/1' },
      { title: 'Hi', blocks: [] },
    )
    expect(posted.id).toBeUndefined()
    expect(calls[1]).toMatchObject({
      url: 'https://hooks.slack.com/commands/1',
      body: { response_type: 'ephemeral', text: 'Hi' },
    })
    const failure = await surface
      .post({ channel: 'C1' }, { title: 'Hi', blocks: [] })
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SlackApiError)
  })

  test('reads channels with a form, private ones included, page by page', async () => {
    const forms: { url: string; type: string | null; body: string }[] = []
    const fetch: SlackFetch = async (url, init) => {
      const body = typeof init.body === 'string' ? init.body : ''
      forms.push({ url, type: new Headers(init.headers).get('content-type'), body })
      const cursor = new URLSearchParams(body).get('cursor')
      return Response.json(
        cursor
          ? { ok: true, channels: [{ id: 'G1', name: 'alpha', is_private: true, is_member: true }] }
          : {
              ok: true,
              channels: [{ id: 'C1', name: 'zeta' }],
              response_metadata: { next_cursor: 'next' },
            },
      )
    }
    const channels = await slackClient({ token: () => 'xoxb-1', fetch }).channels()
    expect(channels).toEqual([
      { id: 'G1', name: 'alpha', private: true, member: true },
      { id: 'C1', name: 'zeta', private: false, member: false },
    ])
    expect(forms[0]?.type).toBe('application/x-www-form-urlencoded')
    expect(new URLSearchParams(forms[0]?.body).get('types')).toBe('public_channel,private_channel')
    expect(new URLSearchParams(forms[1]?.body).get('cursor')).toBe('next')
  })

  test('errors name the method and code, never the token', async () => {
    const { client } = fakeSlack({ 'views.open': { ok: false, error: 'expired_trigger_id' } })
    const error = await client
      .openView('t', formView(form, '{}'))
      .catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(SlackApiError)
    expect(String(error)).toBe('SlackApiError: Slack views.open failed: expired_trigger_id')
    const refused = await client
      .respond('https://evil.example/x', { text: '', blocks: [] })
      .catch((failure: unknown) => failure)
    expect(String(refused)).toContain('bad_url')
  })
})
