import { DEFAULT_TERMS, type MessageCatalog, formatMessage, sourceHash } from './catalog.ts'
import { SOURCE_LOCALE } from './locale.ts'
import type { LocaleTranslations, MessageSettings, MessageStore } from './store.ts'
import type { TranslationItem, Translator } from './translate.ts'
import { translationProblem } from './validate.ts'

/** The texts of one catalog in one locale, ready to format. */
export interface Messages<Key extends string = string> {
  /** The locale the texts are in where they are translated; English otherwise. */
  locale: string
  /** The message `key` with its placeholders filled in from `params`. */
  t: (key: Key, params?: Readonly<Record<string, string | number>>) => string
}

/** After a failed translation, automatic translation of that locale waits this long. */
export const RETRY_AFTER_MS = 60 * 60 * 1000

/** The terms translations of `catalog` keep in English under `settings`. */
export const termsOf = (catalog: MessageCatalog, settings: Pick<MessageSettings, 'terms'>) => [
  ...new Set([...DEFAULT_TERMS, ...(catalog.terms ?? []), ...settings.terms]),
]

/** The state of one message in one locale. */
export type MessageState =
  /** Translated by the model from the current English text. */
  | 'translated'
  /** Written by a person from the current English text. */
  | 'manual'
  /** Translated from an English text that has changed since; English is used instead. */
  | 'outdated'
  /** Not translated; English is used. */
  | 'missing'

/** One message of a catalog with its translation into one locale. */
export interface MessageRow {
  key: string
  source: string
  note?: string
  state: MessageState
  /** The stored translation, current or outdated. */
  text?: string
  updatedAt?: string
  by?: string
  previous?: string
}

/** Every message of `catalog` with the state of its translation in `stored`, in catalog order. */
export function messageRows(
  catalog: MessageCatalog,
  stored: LocaleTranslations,
  terms: readonly string[],
): MessageRow[] {
  return Object.entries(catalog.messages).map(([key, definition]) => {
    const entry = Object.hasOwn(stored.entries, key) ? stored.entries[key] : undefined
    const current = entry?.sourceHash === sourceHash(definition.text, terms)
    const state: MessageState = !entry
      ? 'missing'
      : !current
        ? 'outdated'
        : entry.origin === 'manual'
          ? 'manual'
          : 'translated'
    return {
      key,
      source: definition.text,
      ...(definition.note && { note: definition.note }),
      state,
      ...(entry && {
        text: entry.text,
        updatedAt: entry.updatedAt,
        ...(entry.by && { by: entry.by }),
        ...(entry.previous && { previous: entry.previous }),
      }),
    }
  })
}

/** The catalog's English texts. */
export function sourceMessages<Key extends string>(catalog: MessageCatalog<Key>): Messages<Key> {
  return {
    locale: SOURCE_LOCALE,
    t: (key, params) => formatMessage(catalog.messages[key].text, params),
  }
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * The texts of `catalog` in `locale`. Current translations (made from the English text as it is
 * now, with the same terms) are used as stored; every other message falls back to English. With
 * `autoTranslate` on and a `translator`, missing and outdated messages are first translated in one
 * call, validated (`translationProblem`) and stored, outdated manual ones with the person's text
 * as a hint; a failed call is remembered and not retried for `RETRY_AFTER_MS`. Never throws: any
 * store or translator failure leaves English in place and is logged.
 */
export async function resolveMessages<Key extends string>(options: {
  catalog: MessageCatalog<Key>
  locale: string | undefined
  store?: MessageStore
  translator?: Translator
  now?: () => Date
  log?: (line: string) => void
}): Promise<Messages<Key>> {
  const { catalog, store, log } = options
  const english = sourceMessages(catalog)
  const locale = options.locale
  if (!locale || locale === SOURCE_LOCALE || !store) return english
  const now = options.now ?? (() => new Date())
  let stored: LocaleTranslations
  let settings: MessageSettings
  try {
    ;[stored, settings] = await Promise.all([store.read(catalog.id, locale), store.settings()])
  } catch (error) {
    log?.(`messages: reading ${catalog.id}/${locale} failed: ${errorText(error)}`)
    return english
  }
  const terms = termsOf(catalog, settings)
  const isKey = (key: string): key is Key => Object.hasOwn(catalog.messages, key)
  const keys = Object.keys(catalog.messages).filter(isKey)
  const hashes = new Map(keys.map((key) => [key, sourceHash(catalog.messages[key].text, terms)]))
  const isCurrent = (entries: LocaleTranslations['entries'], key: Key) =>
    Object.hasOwn(entries, key) && entries[key]?.sourceHash === hashes.get(key)

  const pending = keys.filter((key) => !isCurrent(stored.entries, key))
  const waiting =
    stored.failedAt !== undefined && now().getTime() - Date.parse(stored.failedAt) < RETRY_AFTER_MS
  if (pending.length && settings.autoTranslate && options.translator && !waiting) {
    const items = pending.map((key): TranslationItem => {
      const definition = catalog.messages[key]
      const previous = stored.entries[key]
      return {
        key,
        text: definition.text,
        ...(definition.note && { note: definition.note }),
        ...(previous?.origin === 'manual' && { previous: previous.text }),
      }
    })
    try {
      const answer = await options.translator.translate({ locale, items, terms })
      const at = now().toISOString()
      const made = new Map<Key, string>()
      for (const key of pending) {
        const text = Object.hasOwn(answer, key) ? answer[key] : undefined
        const problem =
          text === undefined
            ? 'no translation'
            : translationProblem(catalog.messages[key].text, text, terms)
        if (problem || text === undefined)
          log?.(`messages: ${catalog.id}/${locale} ${key}: ${problem}`)
        else made.set(key, text.trim())
      }
      stored = await store.update(catalog.id, locale, (current) => {
        const entries = { ...current.entries }
        for (const [key, text] of made) {
          const before = stored.entries[key]
          const latest = current.entries[key]
          // A person saved this message while the model was translating it: keep their text.
          if (latest && latest.updatedAt !== before?.updatedAt) continue
          entries[key] = {
            text,
            sourceHash: hashes.get(key) ?? '',
            origin: 'auto',
            updatedAt: at,
            ...(before?.origin === 'manual'
              ? { previous: before.text }
              : before?.previous
                ? { previous: before.previous }
                : {}),
          }
        }
        return { entries }
      })
      log?.(
        `messages: translated ${made.size} of ${pending.length} ${catalog.id} message(s) into ${locale}`,
      )
    } catch (error) {
      log?.(`messages: translating ${catalog.id} into ${locale} failed: ${errorText(error)}`)
      await store
        .update(catalog.id, locale, (current) => ({
          ...current,
          failedAt: now().toISOString(),
          failure: errorText(error).slice(0, 500),
        }))
        .catch(() => undefined)
    }
  }

  const entries = stored.entries
  return {
    locale,
    t: (key, params) => {
      const text = isCurrent(entries, key) ? entries[key]?.text : undefined
      return formatMessage(text ?? catalog.messages[key].text, params)
    },
  }
}
