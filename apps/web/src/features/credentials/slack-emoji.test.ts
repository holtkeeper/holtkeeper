import { expect, test } from 'bun:test'

import { slackEmojiError } from './slack-emoji.ts'

test('accepts blank fields, emoji names, colons and skin tones', () => {
  for (const value of [undefined, '', '  ', 'eyes', ':white_check_mark:', 'thumbsup::skin-tone-2'])
    expect(slackEmojiError(value)).toBeUndefined()
})

test('refuses names Slack does not use', () => {
  for (const value of ['not an emoji', 'Eyes', 'thumbsup::skin-tone-9', 'a'.repeat(101)])
    expect(slackEmojiError(value)).toBeString()
})
