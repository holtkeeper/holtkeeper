import { expect, test } from 'bun:test'

import { memoryStore } from '@holtkeeper/store/memory'

import { fallbackSlackEmoji } from './connection.ts'
import { slackEmojiCatalog } from './emoji.ts'

const NOW = new Date('2026-11-03T09:00:00.000Z')
const connection = { botToken: 'xoxb-widget', signingSecret: 'shape-secret', overrides: {} }

test('defaults try the custom emoji with a fallback until it is known missing', async () => {
  const catalog = slackEmojiCatalog({ store: memoryStore(), now: () => NOW })
  expect(await catalog.choose(connection, 'clean')).toEqual({
    name: 'hk-clean',
    fallback: 'large_green_circle',
  })
  await catalog.remember(connection, 'hk-clean', false)
  expect(await catalog.choose(connection, 'clean')).toEqual({ name: 'large_green_circle' })
  await catalog.remember(connection, 'hk-minor', true)
  expect(await catalog.choose(connection, 'minor')).toEqual({
    name: 'hk-minor',
    fallback: 'large_orange_circle',
    known: true,
  })
})

test('overrides are used as given', async () => {
  const catalog = slackEmojiCatalog({ store: memoryStore(), now: () => NOW })
  const overridden = { ...connection, overrides: { clean: 'thumbsup' } }
  expect(await catalog.choose(overridden, 'clean')).toEqual({ name: 'thumbsup' })
  expect((await catalog.textEmoji(overridden)).clean).toBe('thumbsup')
})

test('text shows fallbacks until one custom emoji is known present, then the set', async () => {
  const store = memoryStore()
  const catalog = slackEmojiCatalog({ store, now: () => NOW })
  expect(await catalog.textEmoji(connection)).toEqual(fallbackSlackEmoji)
  await catalog.remember(connection, 'hk-changes', true)
  await catalog.remember(connection, 'hk-skipped', false)
  const other = slackEmojiCatalog({ store, now: () => NOW })
  expect(await other.textEmoji(connection)).toEqual({
    reviewing: 'hk-reviewing',
    clean: 'hk-clean',
    minor: 'hk-minor',
    changes: 'hk-changes',
    skipped: 'white_circle',
  })
})

test('another bot token is another workspace', async () => {
  const store = memoryStore()
  const catalog = slackEmojiCatalog({ store, now: () => NOW })
  await catalog.remember(connection, 'hk-clean', false)
  expect((await catalog.choose({ ...connection, botToken: 'xoxb-gizmo' }, 'clean')).name).toBe(
    'hk-clean',
  )
})

test('what another process learned expires when it said, not when it was read', async () => {
  const store = memoryStore()
  await slackEmojiCatalog({ store, now: () => NOW }).remember(connection, 'hk-clean', false)
  let now = new Date(NOW.getTime() + 5 * 60 * 60 * 1000)
  const reader = slackEmojiCatalog({ store, now: () => now })
  expect((await reader.choose(connection, 'clean')).name).toBe('large_green_circle')
  now = new Date(NOW.getTime() + 6 * 60 * 60 * 1000 + 1)
  expect((await reader.choose(connection, 'clean')).name).toBe('hk-clean')
})
