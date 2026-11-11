import { describe, expect, test } from 'bun:test'

import { redact } from './http.ts'
import { fit, toMrkdwn } from './slack.ts'
import { type Fetch, type Notification, notificationSchema } from './types.ts'
import { genericWebhook } from './webhook.ts'

const secretUrl = 'https://hooks.example/in/SECRET'

function fakeFetch(statuses: number[], headers: Record<string, string> = {}) {
  const calls: { url: string; init: RequestInit; body: unknown }[] = []
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(typeof init.body === 'string' ? init.body : '') })
    const status = statuses[calls.length - 1] ?? 200
    return new Response(status === 200 ? 'ok' : `failed at ${url}`, { status, headers })
  }
  return { fetch, calls }
}

const noSleep = async () => {}

const failing: Fetch = async (url) => {
  throw new Error(`connect ECONNREFUSED ${url}`)
}

const unauthorized: Fetch = async () => new Response('bad token Bearer token-1', { status: 401 })

const message: Notification = {
  title: 'Release risk: games/app v2',
  text: '- [Breaking](https://x.example/a?b=1&c=2): drop <api>\n- **bold** & done',
  url: 'https://holt.example/analyses/1',
  tone: 'warning',
  fields: [{ label: 'Risk score', value: '42 (+5)' }],
}

describe('mrkdwn', () => {
  test('mrkdwn conversion escapes control characters and converts links, bold and bullets', () => {
    expect(toMrkdwn(message.text)).toBe(
      '• <https://x.example/a?b=1&amp;c=2|Breaking>: drop &lt;api&gt;\n• *bold* &amp; done',
    )
    expect(toMrkdwn('## Title\n<!channel> [a|b](u)')).toBe('*Title*\n&lt;!channel&gt; <u|a/b>')
  })

  test('fit cuts at a line break and marks the cut', () => {
    expect(fit('short', 10)).toBe('short')
    expect(fit('first line\nsecond line', 15)).toBe('first line\n…')
  })
})

describe('genericWebhook', () => {
  test('posts the notification as JSON with resolved headers', async () => {
    const { fetch, calls } = fakeFetch([200])
    await genericWebhook({
      url: 'https://hooks.example/in',
      headers: { Authorization: 'Bearer token-1' },
      fetch,
    }).send(message)
    expect(calls[0]?.body).toEqual(message)
    expect(calls[0]?.init.headers).toEqual({
      authorization: 'Bearer token-1',
      'content-type': 'application/json',
    })
  })

  test('errors never contain header secrets', async () => {
    const error = await genericWebhook({
      url: 'https://h.example',
      headers: { authorization: 'Bearer token-1' },
      fetch: unauthorized,
    })
      .send(message)
      .catch((caught: Error) => caught)
    expect((error as Error).message).toBe('webhook: HTTP 401: bad token <redacted>')
  })

  test('retries once on 429 after Retry-After', async () => {
    const { fetch, calls } = fakeFetch([429, 200], { 'retry-after': '2' })
    const delays: number[] = []
    await genericWebhook({ url: secretUrl, fetch, sleep: async (ms) => void delays.push(ms) }).send(
      message,
    )
    expect(calls).toHaveLength(2)
    expect(delays).toEqual([2000])
    expect(calls[0]?.url).toBe(secretUrl)
    expect(calls[0]?.init.method).toBe('POST')
  })

  test('fails after one retry and redacts the URL', async () => {
    const { fetch, calls } = fakeFetch([503, 500])
    const error = await genericWebhook({ url: secretUrl, fetch, sleep: noSleep })
      .send(message)
      .catch((caught: Error) => caught)
    expect(calls).toHaveLength(2)
    expect((error as Error).message).toBe('webhook: HTTP 500: failed at <redacted>')
    const network = await genericWebhook({ url: secretUrl, fetch: failing, sleep: noSleep })
      .send(message)
      .catch((caught: Error) => caught)
    expect((network as Error).message).toBe(
      'webhook: request failed: connect ECONNREFUSED <redacted>',
    )
  })

  test('resolves the URL from the environment on send', async () => {
    const { fetch, calls } = fakeFetch([200])
    process.env.HOLTKEEPER_TEST_HOOK = secretUrl
    try {
      await genericWebhook({ url: { env: 'HOLTKEEPER_TEST_HOOK' }, fetch }).send(message)
    } finally {
      delete process.env.HOLTKEEPER_TEST_HOOK
    }
    expect(calls[0]?.url).toBe(secretUrl)
  })

  test('schema and redaction helpers', () => {
    expect(notificationSchema.parse(message)).toEqual(message)
    expect(redact('a s3cret b', ['s3cret', ''])).toBe('a <redacted> b')
  })
})
