/** CLDR plural categories in their canonical order. */
export const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'] as const

export type PluralCategory = (typeof PLURAL_CATEGORIES)[number]

const CARDINAL: Record<string, readonly PluralCategory[]> = {
  en: ['one', 'other'],
  ru: ['one', 'few', 'many', 'other'],
  uk: ['one', 'few', 'many', 'other'],
  pl: ['one', 'few', 'many', 'other'],
  de: ['one', 'other'],
  fr: ['one', 'many', 'other'],
  es: ['one', 'many', 'other'],
  it: ['one', 'many', 'other'],
  pt: ['one', 'many', 'other'],
  tr: ['one', 'other'],
  ja: ['other'],
  zh: ['other'],
  ko: ['other'],
  ar: ['zero', 'one', 'two', 'few', 'many', 'other'],
  he: ['one', 'two', 'other'],
  cs: ['one', 'few', 'many', 'other'],
}

const GETTEXT_FORMS: Record<string, number> = {
  en: 2,
  ru: 3,
  uk: 3,
  pl: 3,
  de: 2,
  fr: 2,
  es: 2,
  it: 2,
  pt: 2,
  tr: 2,
  ja: 1,
  zh: 1,
  ko: 1,
  ar: 6,
  he: 2,
  cs: 3,
}

const language = (locale: string) => locale.toLowerCase().split(/[-_]/)[0] ?? locale

const ordered = (categories: Iterable<string>): PluralCategory[] => {
  const set = new Set(categories)
  return PLURAL_CATEGORIES.filter((category) => set.has(category))
}

/**
 * Plural categories a translation into `locale` needs: the embedded CLDR table for common
 * languages, `Intl.PluralRules` for the rest, `one`/`other` when the runtime does not know it.
 */
export function pluralCategories(locale: string, type: 'cardinal' | 'ordinal' = 'cardinal') {
  const table = type === 'cardinal' ? CARDINAL[language(locale)] : undefined
  if (table) return [...table]
  try {
    const tag = locale.replace('_', '-')
    return ordered(new Intl.PluralRules(tag, { type }).resolvedOptions().pluralCategories)
  } catch {
    return ['one', 'other'] as PluralCategory[]
  }
}

/** Number of gettext plural forms a `locale` usually declares; `undefined` when unknown. */
export const gettextForms = (locale: string): number | undefined => GETTEXT_FORMS[language(locale)]

/** Whether two locales share a language, e.g. `en` and `en-GB`. */
export const sameLanguage = (a: string, b: string) => language(a) === language(b)

const SUFFIX = /^(.*?)(_ordinal)?_(zero|one|two|few|many|other)$/

const isCategory = (text: string | undefined): text is PluralCategory =>
  PLURAL_CATEGORIES.some((category) => category === text)

/** i18next plural key parts: `items_few` → `{ stem: 'items', category: 'few' }`. */
export function pluralSuffix(
  key: string,
): { stem: string; category: PluralCategory; ordinal: boolean } | undefined {
  const match = SUFFIX.exec(key)
  const category = match?.[3]
  if (!match?.[1] || !isCategory(category)) return undefined
  return {
    stem: match[2] ? `${match[1]}_ordinal` : match[1],
    category,
    ordinal: Boolean(match[2]),
  }
}

/** The i18next key of one plural variant. */
export const pluralKey = (stem: string, category: PluralCategory) => `${stem}_${category}`
