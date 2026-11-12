import { expect, test } from 'bun:test'

import { slackEmojiError, slackEmojiPlaceholder } from './slack-emoji.ts'

test('accepts blank fields, emoji names, colons and skin tones', () => {
  for (const value of [undefined, '', '  ', 'eyes', ':white_check_mark:', 'thumbsup::skin-tone-2'])
    expect(slackEmojiError(value)).toBeUndefined()
})

test('refuses names Slack does not use', () => {
  for (const value of ['not an emoji', 'Eyes', 'thumbsup::skin-tone-9', 'a'.repeat(101)])
    expect(slackEmojiError(value)).toBeString()
})

test('the placeholder names the default and its fallback', () => {
  expect(slackEmojiPlaceholder('hk-widget', 'large_blue_circle')).toBe(
    'hk-widget, falls back to large_blue_circle',
  )
  expect(slackEmojiPlaceholder('large_blue_circle', 'large_blue_circle')).toBe('large_blue_circle')
})
