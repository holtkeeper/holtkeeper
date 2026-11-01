import type { TicketPlacement } from './types.ts'

const conventional = /^(?<type>[a-z][\w-]*)(?:\((?<scope>[^)]*)\))?(?<bang>!)?:\s(?<subject>.*)$/u

/** A commit title split into its Conventional Commits parts; `type` is absent for other titles. */
export interface Title {
  type?: string
  scope?: string
  breaking: boolean
  /** The title after `type(scope): `, or the whole title. */
  subject: string
}

export function parseTitle(title: string): Title {
  const match = conventional.exec(title.trim())?.groups
  if (!match?.type || match.subject === undefined) return { breaking: false, subject: title.trim() }
  return {
    type: match.type,
    ...(match.scope?.trim() ? { scope: match.scope.trim() } : {}),
    breaking: Boolean(match.bang),
    subject: match.subject.trim(),
  }
}

const ticketKey = /(?<![A-Za-z0-9])[A-Z][A-Z0-9]{1,9}-\d+(?![A-Za-z0-9])/gu
const notTickets = new Set(['UTF', 'ISO', 'RFC', 'SHA', 'CVE', 'ECMA', 'ES', 'TLS', 'SSL', 'MD'])

/** Tracker keys such as `GTW-435` in `text`, in order. */
export function ticketKeys(text: string): string[] {
  return [...text.matchAll(ticketKey)]
    .map((match) => match[0])
    .filter((key) => !notTickets.has(key.slice(0, key.indexOf('-'))))
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

/** Where `key` sits in a title. */
export function ticketPlacement(title: Title, key: string): TicketPlacement {
  const k = escape(key)
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
