import { describe, expect, test } from 'bun:test'

import type { Report } from '@holtkeeper/report'

import { redact } from './http.ts'
import { formatDelta, formatMetricValue, reportNotification } from './report.ts'
import { fit, slackLimits, slackPayload, slackWebhook, toMrkdwn } from './slack.ts'
import { type Fetch, type Notification, notificationSchema } from './types.ts'
import { genericWebhook } from './webhook.ts'

const secretUrl = 'https://hooks.slack.example/services/T000/B000/SECRET'

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

describe('slack', () => {
  test('mrkdwn conversion escapes control characters and converts links, bold and bullets', () => {
    expect(toMrkdwn(message.text)).toBe(
      '• <https://x.example/a?b=1&amp;c=2|Breaking>: drop &lt;api&gt;\n• *bold* &amp; done',
    )
    expect(toMrkdwn('## Title\n<!channel> [a|b](u)')).toBe('*Title*\n&lt;!channel&gt; <u|a/b>')
  })

  test('payload has header, context, text, fields and button', () => {
    const payload = slackPayload(message)
    expect(payload.text).toBe(message.title)
    expect(payload.blocks.map((block) => block.type)).toEqual([
      'header',
      'context',
      'section',
      'section',
      'actions',
    ])
    expect(payload.blocks[3]).toEqual({
      type: 'section',
      fields: [{ type: 'mrkdwn', text: '*Risk score*\n42 (+5)' }],
    })
    expect(payload.blocks[4]).toMatchObject({
      elements: [{ type: 'button', url: message.url, text: { text: 'Open report' } }],
    })
  })

  test('payload respects Slack limits', () => {
    const long: Notification = {
      title: 't'.repeat(400),
      text: Array.from({ length: 500 }, (_, i) => `- line ${i}`).join('\n'),
      fields: Array.from({ length: 25 }, (_, i) => ({ label: `f${i}`, value: 'v'.repeat(3000) })),
      url: `https://x.example/${'a'.repeat(3100)}`,
    }
    const payload = slackPayload(long)
    const [header, section, ...rest] = payload.blocks as {
      type: string
      text?: { text: string }
      fields?: { text: string }[]
    }[]
    expect(header?.text?.text.length).toBe(slackLimits.header)
    expect(section?.text?.text.length).toBeLessThanOrEqual(slackLimits.section)
    expect(section?.text?.text.endsWith('\n…')).toBe(true)
    expect(rest.map((block) => block.fields?.length)).toEqual([10, 10])
    expect(rest[0]?.fields?.every((field) => field.text.length <= slackLimits.field)).toBe(true)
    expect(payload.blocks.some((block) => block.type === 'actions')).toBe(false)
    expect(fit('short', 10)).toBe('short')
  })

  test('posts to the webhook and retries once on 429', async () => {
    const { fetch, calls } = fakeFetch([429, 200], { 'retry-after': '2' })
    const delays: number[] = []
    const notifier = slackWebhook({
      url: secretUrl,
      fetch,
      sleep: async (ms) => void delays.push(ms),
    })
    await notifier.send(message)
    expect(calls).toHaveLength(2)
    expect(delays).toEqual([2000])
    expect(calls[0]?.url).toBe(secretUrl)
    expect(calls[0]?.init.method).toBe('POST')
    expect(calls[1]?.body).toEqual(slackPayload(message))
  })

  test('fails after one retry without leaking the URL', async () => {
    const { fetch, calls } = fakeFetch([503, 500])
    const notifier = slackWebhook({ url: secretUrl, fetch, sleep: noSleep })
    const error = await notifier.send(message).catch((caught: Error) => caught)
    expect(calls).toHaveLength(2)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toStartWith('slack: HTTP 500')
    expect((error as Error).message).not.toContain('SECRET')
  })

  test('does not retry client errors and redacts network errors', async () => {
    const bad = fakeFetch([400])
    const rejected = await slackWebhook({ url: secretUrl, fetch: bad.fetch, sleep: noSleep })
      .send(message)
      .catch((caught: Error) => caught)
    expect((rejected as Error).message).toBe('slack: HTTP 400: failed at <redacted>')
    expect(bad.calls).toHaveLength(1)
    const error = await slackWebhook({ url: secretUrl, fetch: failing, sleep: noSleep })
      .send(message)
      .catch((caught: Error) => caught)
    expect((error as Error).message).toBe('slack: request failed: connect ECONNREFUSED <redacted>')
  })

  test('resolves the URL from the environment on send', async () => {
    const { fetch, calls } = fakeFetch([200])
    process.env.HOLTKEEPER_TEST_SLACK = secretUrl
    try {
      await slackWebhook({ url: { env: 'HOLTKEEPER_TEST_SLACK' }, fetch }).send(message)
    } finally {
      delete process.env.HOLTKEEPER_TEST_SLACK
    }
    expect(calls[0]?.url).toBe(secretUrl)
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
})

describe('reportNotification', () => {
  const report: Report = {
    kind: 'bundle',
    title: 'Bundle',
    subject: { repo: { forge: 'work', path: 'games/app' }, ref: 'v2', compareTo: 'v1' },
    generatedAt: '2026-10-29T00:00:00.000Z',
    metrics: [
      {
        id: 'gzip',
        label: 'Gzip',
        value: 1536,
        unit: 'bytes',
        delta: 512,
        better: 'down',
        tone: 'warning',
      },
      { id: 'share', label: 'Coverage', value: 81.25, unit: 'percent', delta: -2 },
      { id: 'n', label: 'Packages', value: 1204, delta: 0 },
    ],
    sections: [
      {
        id: 's',
        title: 'Issues',
        blocks: [
          {
            type: 'issues',
            items: [
              { id: '1', tone: 'warning', title: 'Grew', detail: '+512 B' },
              { id: '2', tone: 'good', title: 'Fine' },
              { id: '3', tone: 'bad', title: 'Cycle', href: '/analyses/9' },
            ],
          },
        ],
      },
    ],
  }

  test('title, fields with deltas, severe issues first with absolute links, worst tone', () => {
    const result = reportNotification(report, 'https://holt.example/analyses/1', { issues: 1 })
    expect(result).toEqual({
      title: 'Bundle: games/app v2',
      text: 'Compared with v1.\n\n- [Cycle](https://holt.example/analyses/9)\n- ...and 1 more',
      url: 'https://holt.example/analyses/1',
      tone: 'bad',
      fields: [
        { label: 'Gzip', value: '1.5 kB (+512 B)' },
        { label: 'Coverage', value: '81.3% (-2%)' },
        { label: 'Packages', value: '1,204' },
      ],
    })
    expect(notificationSchema.parse(result)).toEqual(result)
  })

  test('formatting helpers', () => {
    expect(formatMetricValue(1500, 'ms')).toBe('1.5 s')
    expect(formatMetricValue('v1.2.0', 'version')).toBe('v1.2.0')
    expect(formatDelta(-2048, 'bytes')).toBe('-2.0 kB')
    expect(redact('a s3cret b', ['s3cret', ''])).toBe('a <redacted> b')
  })
})
