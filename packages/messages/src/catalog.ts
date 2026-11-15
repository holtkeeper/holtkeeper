import { createHash } from 'node:crypto'

/** One message of a catalog: its English text and what a translator needs to know about it. */
export interface MessageDefinition {
  /** The English source; `{name}` marks a placeholder filled in when the message is formatted. */
  text: string
  /** Where the message appears and what it means, for translators and the admin panel. */
  note?: string
}

/**
 * The fixed texts one module shows to people outside the panel (merge request notes, chat
 * messages), in English. Translations are keyed by `id` and the message key, so both must stay
 * stable; changing a message's `text` makes its translations outdated.
 */
export interface MessageCatalog<Key extends string = string> {
  /** Stable id, e.g. `review`. */
  id: string
  /** Name shown in the admin panel. */
  title: string
  messages: Readonly<Record<Key, MessageDefinition>>
  /** Words this catalog's translations keep in English, on top of `DEFAULT_TERMS`. */
  terms?: readonly string[]
}

/** Declares a catalog; the identity function that keeps the key type. */
export const defineCatalog = <Key extends string>(
  catalog: MessageCatalog<Key>,
): MessageCatalog<Key> => catalog

/**
 * Terms every translation keeps in English, as written: product and forge words people know in
 * English and the labels the bot prints untranslated next to messages (severities, `Package`,
 * `Kind`).
 */
export const DEFAULT_TERMS: readonly string[] = [
  'Holtkeeper',
  'merge request',
  'MR',
  'Severity',
  'Critical',
  'Major',
  'Minor',
  'Info',
  'Package',
  'Kind',
]

const escapeRegExp = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Whether `term` occurs in `text` as a whole word, ignoring case. */
const containsTerm = (text: string, term: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(term)}(?![\\p{L}\\p{N}_])`, 'iu').test(text)

/** The terms of `terms` that `text` uses, deduplicated and sorted. */
export const termsIn = (text: string, terms: readonly string[]): string[] =>
  [...new Set(terms.map((term) => term.trim()).filter(Boolean))]
    .filter((term) => containsTerm(text, term))
    .toSorted()

/**
 * The fingerprint a translation is stored with: changes when the English text changes or when the
 * terms it must keep in English change, and only then. A stored translation whose fingerprint
 * differs from the current one is outdated.
 */
export function sourceHash(text: string, terms: readonly string[]): string {
  return createHash('sha256')
    .update(text)
    .update('\u0000')
    .update(termsIn(text, terms).join('\u0000'))
    .digest('hex')
    .slice(0, 16)
}

const PLACEHOLDER = /\{([A-Za-z][\w]*)\}/g

/** Placeholder names of `text` in order of appearance, repeats included. */
export const placeholdersOf = (text: string): string[] =>
  [...text.matchAll(PLACEHOLDER)].map((match) => match[1] ?? '')

/** `text` with every `{name}` that `params` has replaced by its value; unknown ones stay. */
export function formatMessage(
  text: string,
  params: Readonly<Record<string, string | number>> = {},
): string {
  return text.replaceAll(PLACEHOLDER, (whole, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : whole,
  )
}
