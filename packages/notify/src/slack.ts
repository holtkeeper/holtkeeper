/** Slack Block Kit limits. */
export const slackLimits = {
  header: 150,
  section: 3000,
  field: 2000,
  fieldsPerSection: 10,
  fields: 20,
  button: 75,
  url: 3000,
} as const

/** Text with the characters Slack's mrkdwn treats as control characters (`&`, `<`, `>`) escaped. */
export const escapeMrkdwn = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

/**
 * A mrkdwn link `<url|label>` whose label shows as plain text: control characters escaped in
 * both parts, `|` percent-encoded in the URL and replaced with `¦` in the label.
 */
export const mrkdwnLink = (url: string, label: string) =>
  `<${escapeMrkdwn(url).replaceAll('|', '%7C')}|${escapeMrkdwn(label).replaceAll('|', '¦')}>`

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
