import { type Secret, resolveSecret } from '@holtkeeper/forge'
import type { Tone } from '@holtkeeper/report'

import { defaultSleep, post } from './http.ts'
import type { Fetch, Notification, Notifier } from './types.ts'

/** Slack Block Kit limits the notifier keeps to. */
export const slackLimits = {
  header: 150,
  section: 3000,
  field: 2000,
  fieldsPerSection: 10,
  fields: 20,
  button: 75,
  url: 3000,
} as const

/** Escapes the characters Slack's mrkdwn treats as control characters. */
export const escapeMrkdwn = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

const link = /\[([^\]\n]+)\]\(([^)\s]+)\)/gu

function inline(text: string): string {
  return escapeMrkdwn(text).replace(/\*\*(.+?)\*\*/gu, '*$1*')
}

function line(text: string): string {
  const heading = /^#{1,6}\s+(.*)$/u.exec(text)
  if (heading) return `*${inline(heading[1] ?? '').replaceAll('*', '')}*`
  const item = /^(\s*)[-*]\s+(.*)$/u.exec(text)
  if (item) return `${item[1] ?? ''}• ${convertLinks(item[2] ?? '')}`
  return convertLinks(text)
}

function convertLinks(text: string): string {
  let out = ''
  let last = 0
  for (const match of text.matchAll(link)) {
    out += inline(text.slice(last, match.index))
    const label = escapeMrkdwn(match[1] ?? '').replaceAll('|', '/')
    const href = escapeMrkdwn(match[2] ?? '').replaceAll('|', '%7C')
    out += `<${href}|${label}>`
    last = match.index + match[0].length
  }
  return out + inline(text.slice(last))
}

/**
 * Markdown-ish text as Slack mrkdwn: `**bold**` → `*bold*`, headings → bold lines, `- ` items →
 * bullets, `[label](url)` → `<url|label>`. Everything else is escaped, so text cannot mention
 * users or channels or forge links.
 */
export const toMrkdwn = (text: string) => text.split('\n').map(line).join('\n')

/** Shortens text to `max` characters, preferring a line break, and marks the cut with `…`. */
export function fit(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.lastIndexOf('\n', max - 2)
  return cut > max / 2 ? `${text.slice(0, cut)}\n…` : `${text.slice(0, max - 1)}…`
}

const toneLabel: Partial<Record<Tone, string>> = {
  good: ':large_green_circle: Good',
  info: ':large_blue_circle: Info',
  warning: ':large_yellow_circle: Warning',
  bad: ':red_circle: Problem',
}

/** The webhook payload for a notification: header, tone context, text, fields and a button. */
export function slackPayload(message: Notification, options: { button?: string } = {}) {
  const blocks: Record<string, unknown>[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: fit(message.title, slackLimits.header), emoji: true },
    },
  ]
  const tone = message.tone && toneLabel[message.tone]
  if (tone) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: tone }] })
  const text = toMrkdwn(message.text.trim())
  if (text)
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: fit(text, slackLimits.section) } })
  const fields = (message.fields ?? []).slice(0, slackLimits.fields).map((field) => ({
    type: 'mrkdwn',
    text: fit(`*${escapeMrkdwn(field.label)}*\n${escapeMrkdwn(field.value)}`, slackLimits.field),
  }))
  for (let i = 0; i < fields.length; i += slackLimits.fieldsPerSection)
    blocks.push({ type: 'section', fields: fields.slice(i, i + slackLimits.fieldsPerSection) })
  if (message.url && message.url.length <= slackLimits.url)
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: fit(options.button ?? 'Open report', slackLimits.button),
          },
          url: message.url,
        },
      ],
    })
  return { text: fit(message.title, slackLimits.section), blocks }
}

export interface SlackWebhookOptions {
  /** Incoming webhook URL; resolved on every send. */
  url: Secret
  /** Button label. Default `Open report`. */
  button?: string
  /** Default `slack`. */
  name?: string
  fetch?: Fetch
  sleep?: (ms: number) => Promise<void>
}

/** A notifier posting Block Kit messages to a Slack incoming webhook. */
export function slackWebhook(options: SlackWebhookOptions): Notifier {
  const { name = 'slack', fetch = globalThis.fetch, sleep = defaultSleep } = options
  return {
    name,
    async send(message) {
      await post({
        name,
        url: resolveSecret(options.url),
        body: JSON.stringify(
          slackPayload(message, options.button ? { button: options.button } : {}),
        ),
        headers: { 'content-type': 'application/json' },
        fetch,
        sleep,
      })
    },
  }
}
