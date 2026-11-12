import { expect, test } from 'bun:test'

import { slackSignature, verifySlackSignature } from './signature.ts'

const now = new Date('2026-11-03T09:00:00.000Z')
const timestamp = String(now.getTime() / 1000)
const body = '{"type":"event_callback","event":{"type":"message"}}'

const verify = (overrides: Partial<Parameters<typeof verifySlackSignature>[0]> = {}) =>
  verifySlackSignature({
    signingSecret: 'shape-secret',
    timestamp,
    signature: slackSignature('shape-secret', timestamp, body),
    body,
    now,
    ...overrides,
  })

test('accepts a request signed with the signing secret', () => {
  expect(slackSignature('shape-secret', timestamp, body)).toMatch(/^v0=[0-9a-f]{64}$/)
  expect(verify()).toBe(true)
})

test('rejects another secret, a changed body and missing headers', () => {
  expect(verify({ signature: slackSignature('other-secret', timestamp, body) })).toBe(false)
  expect(verify({ body: `${body} ` })).toBe(false)
  expect(verify({ signature: undefined })).toBe(false)
  expect(verify({ timestamp: undefined })).toBe(false)
  expect(verify({ timestamp: 'soon' })).toBe(false)
})

test('rejects requests signed more than five minutes away', () => {
  const stale = String(now.getTime() / 1000 - 301)
  expect(verify({ timestamp: stale, signature: slackSignature('shape-secret', stale, body) })).toBe(
    false,
  )
  const recent = String(now.getTime() / 1000 - 299)
  expect(
    verify({ timestamp: recent, signature: slackSignature('shape-secret', recent, body) }),
  ).toBe(true)
})
