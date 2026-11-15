import { z } from 'zod'

/** One stored translation of one message. */
const storedTranslationSchema = z.object({
  text: z.string(),
  /** `sourceHash` of the English text the translation was made from. */
  sourceHash: z.string(),
  /** `auto`: written by the translation model; `manual`: written by a person in the panel. */
  origin: z.enum(['auto', 'manual']),
  updatedAt: z.string(),
  /** Who wrote a manual translation. */
  by: z.string().optional(),
  /** The manual translation an automatic one replaced after the English text changed. */
  previous: z.string().optional(),
})

export type StoredTranslation = z.infer<typeof storedTranslationSchema>

/** The translations of one catalog into one locale. */
const localeTranslationsSchema = z.object({
  entries: z.record(z.string(), storedTranslationSchema),
  /** When translating failed last; automatic translation waits `RETRY_AFTER_MS` after it. */
  failedAt: z.string().optional(),
  failure: z.string().optional(),
})

export type LocaleTranslations = z.infer<typeof localeTranslationsSchema>

/** How translations are made, for every catalog. */
export const messageSettingsSchema = z.object({
  /** Translate missing and outdated messages with the AI model when they are first needed. */
  autoTranslate: z.boolean(),
  /** Terms kept in English on top of `DEFAULT_TERMS` and the catalog's own. */
  terms: z.array(z.string().trim().min(1).max(60)).max(100),
})

export type MessageSettings = z.infer<typeof messageSettingsSchema>

/** The settings while nobody changed them: translate automatically, no extra terms. */
export const DEFAULT_MESSAGE_SETTINGS: MessageSettings = { autoTranslate: true, terms: [] }

/** Where translations and their settings are kept. */
export interface MessageStore {
  settings(): Promise<MessageSettings>
  saveSettings(settings: MessageSettings): Promise<void>
  /** Locales that have translations of `catalog`, sorted. */
  locales(catalog: string): Promise<string[]>
  /** The translations of `catalog` into `locale`; empty when there are none. */
  read(catalog: string, locale: string): Promise<LocaleTranslations>
  /**
   * Replaces the translations of `catalog` into `locale` with what `change` makes of the current
   * ones. Where the store can, the change is applied atomically and retried on a concurrent write,
   * so an automatic translation never overwrites a person's edit made meanwhile.
   */
  update(
    catalog: string,
    locale: string,
    change: (current: LocaleTranslations) => LocaleTranslations,
  ): Promise<LocaleTranslations>
}

/** The key-value operations `kvMessageStore` needs; `KvStore` of `@holtkeeper/store` has them. */
export interface MessageKv {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  compareAndSet?(key: string, expected: unknown, value: unknown): Promise<boolean>
}

const SETTINGS_KEY = 'messages:settings'
const localeKey = (catalog: string, locale: string) => `messages:${catalog}:locale:${locale}`
const indexKey = (catalog: string) => `messages:${catalog}:locales`
const MAX_ATTEMPTS = 5

const empty = (): LocaleTranslations => ({ entries: {} })

/**
 * A `MessageStore` over a key-value store: one value per catalog and locale, an index of locales
 * per catalog and one settings value. Updates use `compareAndSet` when the store has it.
 */
export function kvMessageStore(kv: MessageKv): MessageStore {
  const readRaw = async (key: string) => {
    const raw = await kv.get(key)
    return { raw, parsed: localeTranslationsSchema.safeParse(raw).data ?? empty() }
  }
  const remember = async (catalog: string, locale: string) => {
    const known = z.array(z.string()).safeParse(await kv.get(indexKey(catalog))).data ?? []
    if (known.includes(locale)) return
    await kv.set(indexKey(catalog), [...known, locale].toSorted())
  }
  return {
    async settings() {
      return {
        ...DEFAULT_MESSAGE_SETTINGS,
        ...messageSettingsSchema.partial().safeParse(await kv.get(SETTINGS_KEY)).data,
      }
    },
    async saveSettings(settings) {
      await kv.set(SETTINGS_KEY, messageSettingsSchema.parse(settings))
    },
    async locales(catalog) {
      return z.array(z.string()).safeParse(await kv.get(indexKey(catalog))).data ?? []
    },
    async read(catalog, locale) {
      return (await readRaw(localeKey(catalog, locale))).parsed
    },
    async update(catalog, locale, change) {
      const key = localeKey(catalog, locale)
      for (let attempt = 1; ; attempt++) {
        // oxlint-disable-next-line no-await-in-loop
        const { raw, parsed } = await readRaw(key)
        const next = localeTranslationsSchema.parse(change(parsed))
        if (!kv.compareAndSet || attempt >= MAX_ATTEMPTS) {
          // oxlint-disable-next-line no-await-in-loop
          await kv.set(key, next)
          // oxlint-disable-next-line no-await-in-loop
          await remember(catalog, locale)
          return next
        }
        // oxlint-disable-next-line no-await-in-loop
        if (await kv.compareAndSet(key, raw, next)) {
          // oxlint-disable-next-line no-await-in-loop
          await remember(catalog, locale)
          return next
        }
      }
    },
  }
}

/** A `MessageStore` in memory; for tests and setups without storage. */
export function memoryMessageStore(): MessageStore {
  const values = new Map<string, unknown>()
  return kvMessageStore({
    get: async (key) => structuredClone(values.get(key)),
    set: async (key, value) => {
      values.set(key, structuredClone(value))
    },
  })
}
