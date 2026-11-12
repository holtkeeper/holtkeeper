const assets = 'https://raw.githubusercontent.com/holtkeeper/.github/main'

/** The Holtkeeper Slack app's avatar. */
export const botAvatar = `${assets}/profile/assets/slack-bot.png`

/** The review status emoji of the Slack app, by their workspace names. */
export const statusEmoji = {
  'hk-reviewing': `${assets}/slack/emoji/hk-reviewing.gif`,
  'hk-clean': `${assets}/slack/emoji/hk-clean.png`,
  'hk-minor': `${assets}/slack/emoji/hk-minor.png`,
  'hk-changes': `${assets}/slack/emoji/hk-changes.png`,
  'hk-skipped': `${assets}/slack/emoji/hk-skipped.png`,
} as const

export type StatusEmoji = keyof typeof statusEmoji

/** Where the Slack app's manifest, emoji and avatar are published. */
export const slackAssetsUrl = 'https://github.com/holtkeeper/.github/tree/main/slack'
