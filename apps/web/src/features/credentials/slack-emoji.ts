const emojiName = /^[a-z0-9][a-z0-9_+'-]*(::skin-tone-[2-6])?$/

/**
 * Why a review status emoji override would be refused, or `undefined` when it is blank (the
 * default applies) or a Slack emoji name the server accepts (`:eyes:` counts as `eyes`).
 */
export function slackEmojiError(value: string | undefined): string | undefined {
  const name = (value ?? '').trim().replace(/^:+|:+$/g, '')
  if (!name) return undefined
  if (name.length <= 100 && emojiName.test(name)) return undefined
  return 'A Slack emoji name such as eyes or large_green_circle'
}

/** Where Holtkeeper's custom review status emoji are kept, ready to upload to a workspace. */
export const slackEmojiSetUrl = 'https://github.com/holtkeeper/.github/tree/main/slack/emoji'

/** What a status without an override shows: its default, and the standard emoji it falls back to. */
export function slackEmojiPlaceholder(defaultName: string, fallback: string): string {
  return defaultName === fallback ? defaultName : `${defaultName}, falls back to ${fallback}`
}
