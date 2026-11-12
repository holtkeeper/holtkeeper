import { describe, expect, test } from 'bun:test'

import type { SettingEntry } from '@holtkeeper/store'

import { slackReviews } from './definitions.ts'
import { resolveSlackReviewChannels } from './slack-reviews.ts'

const widget = { forge: 'acme', path: 'shapes/widget', groups: ['shapes'] }
const gadget = { forge: 'acme', path: 'tools/gadget', groups: ['tools'] }

const entry = (id: string, scope: SettingEntry['scope'], value: unknown): SettingEntry => ({
  id,
  key: 'slack.reviews',
  scope,
  value,
  secret: false,
  updatedAt: '2026-11-01T00:00:00.000Z',
})

describe('slack.reviews', () => {
  test('binds no channel without an entry', () => {
    expect(resolveSlackReviewChannels([], widget)).toEqual([])
    expect(slackReviews.default).toEqual({ channels: [] })
  })

  test('the most specific entry wins, so groups report to their own channels', () => {
    const entries = [
      entry('all', { all: true }, { channels: ['C0000ALL'] }),
      entry('shapes', { groups: ['shapes'] }, { channels: ['C0000SHAPES', 'G0000PRIVATE'] }),
    ]
    expect(resolveSlackReviewChannels(entries, widget)).toEqual(['C0000SHAPES', 'G0000PRIVATE'])
    expect(resolveSlackReviewChannels(entries, gadget)).toEqual(['C0000ALL'])
  })

  test('an entry without channels keeps a group quiet', () => {
    const entries = [
      entry('all', { all: true }, { channels: ['C0000ALL'] }),
      entry('shapes', { groups: ['shapes'] }, { channels: [] }),
    ]
    expect(resolveSlackReviewChannels(entries, widget)).toEqual([])
  })

  test('accepts channel ids only', () => {
    expect(slackReviews.schema.safeParse({ channels: ['C0123ABCD'] }).success).toBe(true)
    expect(slackReviews.schema.safeParse({ channels: ['#widgets'] }).success).toBe(false)
    expect(
      resolveSlackReviewChannels([entry('bad', { all: true }, { channels: [1] })], widget),
    ).toEqual([])
  })
})
