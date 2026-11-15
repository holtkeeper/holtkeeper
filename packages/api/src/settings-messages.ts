/** How the translation of one message stands in one locale. */
export type BotMessageState = 'translated' | 'manual' | 'outdated' | 'missing'

/** How bot messages are translated, for every catalog. */
export interface BotMessageSettings {
  /** Translate missing and outdated messages with the AI model when a review first needs them. */
  autoTranslate: boolean
  /** Terms kept in English on top of the built-in ones. */
  terms: string[]
}

/** Counts of one catalog's messages per state in one locale. */
export interface BotMessageLocaleSummary {
  locale: string
  /** English name of the language, e.g. `Russian`. */
  label: string
  counts: Record<BotMessageState, number>
  /** The last failed automatic translation; it is retried an hour later. */
  failedAt?: string
  failure?: string
}

/** One catalog of fixed bot texts and its locales. */
export interface BotMessageCatalogSummary {
  id: string
  title: string
  messages: number
  locales: BotMessageLocaleSummary[]
}

/**
 * `GET /api/messages` — the fixed texts Holtkeeper posts outside the panel and their translations;
 * needs a global `settings:read`. `available` is false when the server has no key-value store, so
 * nothing can be stored and every text is posted in English.
 */
export interface BotMessagesOverview {
  available: boolean
  settings: BotMessageSettings
  /** Terms every translation keeps in English, whatever the settings say. */
  builtInTerms: string[]
  catalogs: BotMessageCatalogSummary[]
}

/** One message with its translation into the viewed locale. */
export interface BotMessageRow {
  key: string
  /** The English text. */
  source: string
  note?: string
  state: BotMessageState
  /** The stored translation, current or outdated. */
  text?: string
  updatedAt?: string
  by?: string
  /** The manual translation an automatic one replaced after the English text changed. */
  previous?: string
}

/** `GET /api/messages/:catalog/:locale` — every message of a catalog in one locale. */
export interface BotMessageLocale {
  catalog: string
  title: string
  locale: string
  label: string
  /** Every term the translations keep in English. */
  terms: string[]
  rows: BotMessageRow[]
}

/** `PUT /api/messages/:catalog/:locale/:key` — a person's translation of one message. */
export interface BotMessageInput {
  text: string
}
