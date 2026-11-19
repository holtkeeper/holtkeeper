import type { TicketPlacement } from './types.ts'

const leadingTicket = /^\[(?<key>[A-Z][A-Z0-9]{1,9}-\d+)\]\s*/u
const conventional =
  /^(?<type>[a-z][\w-]*)(?:\((?<scope>[^)]*)\))?(?<bang>!)?\s?:\s(?<subject>.*)$/u

/** A commit title split into its Conventional Commits parts; `type` is absent for other titles. */
export interface Title {
  type?: string
  scope?: string
  breaking: boolean
  /** A bracketed ticket key before the type: `[ABC-1] feat: subject`. */
  lead?: string
  /** The title after `type(scope): `, or the whole title. */
  subject: string
}

export function parseTitle(title: string): Title {
  const trimmed = title.trim()
  const lead = leadingTicket.exec(trimmed)
  const match = conventional.exec(lead ? trimmed.slice(lead[0].length) : trimmed)?.groups
  if (!match?.type || match.subject === undefined) return { breaking: false, subject: trimmed }
  return {
    type: match.type,
    ...(lead?.groups?.key ? { lead: lead.groups.key } : {}),
    ...(match.scope?.trim() ? { scope: match.scope.trim() } : {}),
    breaking: Boolean(match.bang),
    subject: match.subject.trim(),
  }
}

const ticketKey = /(?<![A-Za-z0-9])[A-Z][A-Z0-9]{1,9}-\d+(?![A-Za-z0-9])/gu
const notTickets = new Set(['UTF', 'ISO', 'RFC', 'SHA', 'CVE', 'ECMA', 'ES', 'TLS', 'SSL', 'MD'])

/** Tracker keys such as `ABC-435` in `text`, in order. */
export function ticketKeys(text: string): string[] {
  return [...text.matchAll(ticketKey)]
    .map((match) => match[0])
    .filter((key) => !notTickets.has(key.slice(0, key.indexOf('-'))))
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

/** Where `key` sits in a title. */
export function ticketPlacement(title: Title, key: string): TicketPlacement {
  const k = escape(key)
  if (title.lead === key) return 'lead'
  if (title.scope === key) return 'scope'
  if (new RegExp(`^\\[${k}\\]`, 'u').test(title.subject)) return 'bracket'
  if (new RegExp(`^${k}(?::|\\s)`, 'u').test(title.subject)) return 'prefix'
  if (new RegExp(`[([]?${k}[)\\]]?$`, 'u').test(title.subject)) return 'suffix'
  return 'anywhere'
}

/** A regular expression source matching a key of any of `projects`. */
export function ticketPattern(projects: readonly string[]): string {
  const keys = projects.map(escape)
  return `${keys.length === 1 ? keys[0] : `(?:${keys.join('|')})`}-\\d+`
}

const trailer = /^[A-Z][\w-]*:\s/u

/** Whether the message has text after the title other than blank lines and git trailers. */
export function hasBody(message: string): boolean {
  return message
    .split('\n')
    .slice(1)
    .some((line) => line.trim() !== '' && !trailer.test(line.trim()))
}

/**
 * `pattern` compiled for JavaScript: a leading `(?i)` becomes the `i` flag. `undefined` when the
 * forge's dialect uses syntax JavaScript lacks.
 */
export function compilePattern(pattern: string): RegExp | undefined {
  const insensitive = pattern.startsWith('(?i)')
  try {
    return new RegExp(insensitive ? pattern.slice(4) : pattern, insensitive ? 'mi' : 'm')
  } catch {
    return undefined
  }
}

/**
 * The Conventional Commits shape of a title with the ticket key where `ticket` puts it, e.g.
 * `[KEY-1] type(scope): subject` for a key in brackets before the type, so a rule about the
 * type never contradicts the rule about the key. `scoped: false` (no scopes known) leaves out the
 * `(scope)`.
 */
export function conventionalShape(
  ticket?: { required: boolean; placement?: string },
  scoped = true,
): string {
  const head = scoped ? 'type(scope)' : 'type'
  if (!ticket?.required) return `${head}: subject`
  switch (ticket.placement) {
    case 'lead':
      return `[KEY-1] ${head}: subject`
    case 'bracket':
      return `${head}: [KEY-1] subject`
    case 'prefix':
      return `${head}: KEY-1 subject`
    case 'scope':
      return 'type(KEY-1): subject'
    case 'suffix':
      return `${head}: subject (KEY-1)`
    default:
      return `${head}: subject`
  }
}

/** Whether a title is one git or the forge writes for a merge, which follows no convention. */
export const isMergeTitle = (title: string) =>
  /^Merge (branch|remote-tracking branch|pull request|tag) /.test(title) ||
  /^Merge .+ into .+/.test(title)
