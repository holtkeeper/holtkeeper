import { expect, test } from 'bun:test'

import { slackWebApi, slackWebPoster } from './client.ts'

const answer = (body: unknown, init: ResponseInit = {}) => Response.json(body, init)

const recording = (responses: Response[]) => {
  const calls: { url: string; body: unknown }[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(typeof init.body === 'string' ? init.body : '{}') })
    const next = responses.shift()
    if (!next) throw new Error('no answer left')
    return next
  }) as unknown as typeof globalThis.fetch
  return { calls, fetch }
}

test('adds and removes reactions, treating already done as success', async () => {
  const { calls, fetch } = recording([
    answer({ ok: false, error: 'already_reacted' }),
    answer({ ok: false, error: 'no_reaction' }),
  ])
  const api = slackWebApi({ token: 'xoxb-widget', fetch, log: () => {} })
  expect(await api.addReaction({ channel: 'C0123ABCD', ts: '1.2', name: 'eyes' })).toEqual({
    ok: true,
  })
  expect(await api.removeReaction({ channel: 'C0123ABCD', ts: '1.2', name: 'eyes' })).toEqual({
    ok: true,
  })
  expect(calls).toEqual([
    {
      url: 'https://slack.com/api/reactions.add',
      body: { channel: 'C0123ABCD', timestamp: '1.2', name: 'eyes' },
    },
    {
      url: 'https://slack.com/api/reactions.remove',
      body: { channel: 'C0123ABCD', timestamp: '1.2', name: 'eyes' },
    },
  ])
})

test('an unknown emoji fails an add without a log line and counts as removed', async () => {
  const lines: string[] = []
  const { fetch } = recording([
    answer({ ok: false, error: 'invalid_name' }),
    answer({ ok: false, error: 'invalid_name' }),
  ])
  const api = slackWebApi({ token: 'xoxb-widget', fetch, log: (line) => lines.push(line) })
  expect(await api.addReaction({ channel: 'C0123ABCD', ts: '1.2', name: 'hk-widget' })).toEqual({
    ok: false,
    error: 'invalid_name',
  })
  expect(await api.removeReaction({ channel: 'C0123ABCD', ts: '1.2', name: 'hk-widget' })).toEqual({
    ok: true,
  })
  expect(lines).toEqual([])
})

test('waits out a rate limit, then gives up without throwing', async () => {
  const waits: number[] = []
  const lines: string[] = []
  const { calls, fetch } = recording([
    new Response('', { status: 429, headers: { 'retry-after': '2' } }),
    answer({ ok: true }),
    new Response('', { status: 429, headers: { 'retry-after': '1' } }),
    new Response('', { status: 429, headers: { 'retry-after': '1' } }),
  ])
  const api = slackWebApi({
    token: 'xoxb-widget',
    fetch,
    retries: 1,
    sleep: async (ms) => {
      waits.push(ms)
    },
    log: (line) => lines.push(line),
  })
  expect((await api.addReaction({ channel: 'C0123ABCD', ts: '1.2', name: 'eyes' })).ok).toBe(true)
  expect(await api.addReaction({ channel: 'C0123ABCD', ts: '1.2', name: 'eyes' })).toEqual({
    ok: false,
    error: 'ratelimited',
  })
  expect(waits).toEqual([2000, 1000])
  expect(calls).toHaveLength(4)
  expect(lines).toEqual(['slack reactions.add: rate limited'])
})

test('logs Slack errors and network failures instead of throwing', async () => {
  const lines: string[] = []
  const { fetch } = recording([answer({ ok: false, error: 'not_in_channel' })])
  const api = slackWebApi({ token: 'xoxb-widget', fetch, log: (line) => lines.push(line) })
  expect(await api.addReaction({ channel: 'C0123ABCD', ts: '1.2', name: 'eyes' })).toEqual({
    ok: false,
    error: 'not_in_channel',
  })
  expect(await api.removeReaction({ channel: 'C0123ABCD', ts: '1.2', name: 'eyes' })).toEqual({
    ok: false,
    error: 'no answer left',
  })
  expect(lines).toEqual([
    'slack reactions.add: not_in_channel',
    'slack reactions.remove: no answer left',
  ])
})

test('rate-limit waits of all calls share one budget', async () => {
  const waits: number[] = []
  const { calls, fetch } = recording([
    new Response('', { status: 429, headers: { 'retry-after': '3' } }),
    answer({ ok: true }),
    new Response('', { status: 429, headers: { 'retry-after': '3' } }),
  ])
  const api = slackWebApi({
    token: 'xoxb-widget',
    fetch,
    budgetMs: 5000,
    sleep: async (ms) => {
      waits.push(ms)
    },
    log: () => undefined,
  })
  expect((await api.addReaction({ channel: 'C0123ABCD', ts: '1.2', name: 'eyes' })).ok).toBe(true)
  expect(await api.removeReaction({ channel: 'C0123ABCD', ts: '1.2', name: 'eyes' })).toEqual({
    ok: false,
    error: 'ratelimited',
  })
  expect(waits).toEqual([3000])
  expect(calls).toHaveLength(3)
})

test('posts and updates messages, answering the message ts', async () => {
  const { calls, fetch } = recording([
    answer({ ok: true, channel: 'C0123ABCD', ts: '1700000000.000100' }),
    answer({ ok: true, channel: 'C0123ABCD', ts: '1700000000.000100' }),
    answer({ ok: false, error: 'not_in_channel' }),
  ])
  const lines: string[] = []
  const poster = slackWebPoster({ token: 'xoxb-widget', fetch, log: (line) => lines.push(line) })
  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: 'hi' } }]
  expect(await poster.post({ channel: 'C0123ABCD', text: 'hi', blocks })).toEqual({
    ok: true,
    channel: 'C0123ABCD',
    ts: '1700000000.000100',
  })
  expect(
    await poster.update({ channel: 'C0123ABCD', ts: '1700000000.000100', text: 'hey' }),
  ).toMatchObject({ ok: true })
  expect(
    await poster.post({ channel: 'C0456ABCD', threadTs: '1700000000.000100', text: 'hi' }),
  ).toEqual({
    ok: false,
    error: 'not_in_channel',
  })
  expect(calls).toEqual([
    {
      url: 'https://slack.com/api/chat.postMessage',
      body: { channel: 'C0123ABCD', text: 'hi', blocks, unfurl_links: false, unfurl_media: false },
    },
    {
      url: 'https://slack.com/api/chat.update',
      body: { channel: 'C0123ABCD', ts: '1700000000.000100', text: 'hey' },
    },
    {
      url: 'https://slack.com/api/chat.postMessage',
      body: {
        channel: 'C0456ABCD',
        thread_ts: '1700000000.000100',
        text: 'hi',
        unfurl_links: false,
        unfurl_media: false,
      },
    },
  ])
  expect(lines).toEqual(['slack chat.postMessage: not_in_channel'])
})
