/** The locale of the English source texts. */
export const SOURCE_LOCALE = 'en'

/** Languages names in options are matched against, by their ISO 639-1 code. */
const KNOWN_LANGUAGES = [
  'ar',
  'be',
  'bg',
  'bn',
  'ca',
  'cs',
  'da',
  'de',
  'el',
  'en',
  'es',
  'et',
  'fa',
  'fi',
  'fr',
  'he',
  'hi',
  'hr',
  'hu',
  'hy',
  'id',
  'it',
  'ja',
  'ka',
  'kk',
  'ko',
  'lt',
  'lv',
  'ms',
  'nb',
  'nl',
  'no',
  'pl',
  'pt',
  'ro',
  'ru',
  'sk',
  'sl',
  'sr',
  'sv',
  'th',
  'tr',
  'uk',
  'uz',
  'vi',
  'zh',
] as const

const CODE = /^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/i

const baseOf = (tag: string): string | undefined => {
  try {
    const [canonical] = Intl.getCanonicalLocales(tag.replaceAll('_', '-'))
    return canonical ? new Intl.Locale(canonical).language : undefined
  } catch {
    return undefined
  }
}

let names: Map<string, string> | undefined

/** Lowercase English and native names of the known languages, mapped to their codes. */
const languageNames = () => {
  if (names) return names
  names = new Map()
  const english = new Intl.DisplayNames(['en'], { type: 'language' })
  for (const code of KNOWN_LANGUAGES) {
    const native = new Intl.DisplayNames([code], { type: 'language' })
    for (const name of [english.of(code), native.of(code)])
      if (name && !names.has(name.toLowerCase())) names.set(name.toLowerCase(), code)
  }
  return names
}

/**
 * The base language code (`ru`, `pt`) a language setting names: a BCP 47 tag (`ru`, `pt-BR`,
 * `zh_Hant`) or a language name in English or in the language itself (`Russian`, `русский`).
 * `undefined` for anything else, including an empty value.
 */
export function normalizeLocale(language: string | undefined): string | undefined {
  const value = language?.trim()
  if (!value) return undefined
  if (CODE.test(value)) {
    const base = baseOf(value)
    if (base) return base
  }
  return languageNames().get(value.toLowerCase())
}

/** The English name of a locale (`Russian` for `ru`), or the code when the runtime has none. */
export function localeLabel(locale: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(locale) ?? locale
  } catch {
    return locale
  }
}

const STOPWORDS: Record<string, readonly string[]> = {
  en: ['the', 'and', 'is', 'to', 'of', 'this', 'with', 'for', 'that', 'it', 'in', 'on'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'mit', 'für', 'auf', 'ein', 'eine', 'zu'],
  fr: ['le', 'la', 'les', 'et', 'est', 'pour', 'dans', 'une', 'des', 'avec', 'pas', 'du'],
  es: ['el', 'los', 'las', 'y', 'es', 'para', 'con', 'una', 'del', 'por', 'que', 'se'],
  pt: ['o', 'os', 'e', 'é', 'para', 'com', 'uma', 'não', 'do', 'da', 'que', 'em'],
  it: ['il', 'gli', 'e', 'è', 'per', 'con', 'una', 'non', 'del', 'della', 'che', 'di'],
  nl: ['de', 'het', 'een', 'en', 'is', 'van', 'voor', 'met', 'niet', 'op', 'dat', 'te'],
  pl: ['i', 'jest', 'nie', 'w', 'na', 'z', 'do', 'się', 'że', 'to', 'dla', 'oraz'],
  tr: ['ve', 'bir', 'bu', 'için', 'ile', 'değil', 'da', 'de', 'olarak', 'çok', 'gibi', 'daha'],
}

const plainText = (text: string) =>
  text
    .replaceAll(/```[\s\S]*?(?:```|$)/g, ' ')
    .replaceAll(/`[^`]*`/g, ' ')
    .replaceAll(/<!--[\s\S]*?-->/g, ' ')
    .replaceAll(/\]\([^)]*\)/g, ']')
    .replaceAll(/\bhttps?:\/\/\S+/g, ' ')

const count = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0

/**
 * A best guess at the language of `text` (a merge request description), as a base language code;
 * `undefined` when there is too little prose to tell. Code, links and HTML comments are ignored.
 * The script decides first (Cyrillic, CJK, Arabic, ...: a script holding at least a third of the
 * letters wins over the English words technical prose is full of); Latin text is told apart by
 * common words and is English unless another language clearly has more of them.
 */
export function detectLocale(text: string): string | undefined {
  const prose = plainText(text)
  const letters = count(prose, /\p{L}/gu)
  if (letters < 12) return undefined
  const share = (pattern: RegExp) => count(prose, pattern) / letters
  if (share(/\p{Script=Cyrillic}/gu) >= 0.33) {
    const ukrainian = count(prose, /[іїєґІЇЄҐ]/gu)
    const russian = count(prose, /[ыэъёЫЭЪЁ]/gu)
    return ukrainian > russian ? 'uk' : 'ru'
  }
  if (share(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu) >= 0.1) return 'ja'
  if (share(/\p{Script=Hangul}/gu) >= 0.2) return 'ko'
  if (share(/\p{Script=Han}/gu) >= 0.2) return 'zh'
  if (share(/\p{Script=Arabic}/gu) >= 0.33) return 'ar'
  if (share(/\p{Script=Hebrew}/gu) >= 0.33) return 'he'
  if (share(/\p{Script=Greek}/gu) >= 0.33) return 'el'
  const words = prose.toLowerCase().match(/\p{L}+/gu) ?? []
  const scores = Object.entries(STOPWORDS).map(([locale, list]) => {
    const set = new Set(list)
    return { locale, score: words.filter((word) => set.has(word)).length }
  })
  const english = scores.find((entry) => entry.locale === 'en')?.score ?? 0
  const best = scores.toSorted((a, b) => b.score - a.score)[0]
  if (best && best.locale !== 'en' && best.score >= 3 && best.score > english * 1.5)
    return best.locale
  return 'en'
}
