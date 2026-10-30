import type { CatalogLocation } from './types.ts'

const LANGUAGES = new Set(
  (
    'aa ab af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy ' +
    'da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht ' +
    'hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky ' +
    'la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny ' +
    'oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss ' +
    'st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo ' +
    'za zh zu fil haw yue'
  ).split(' '),
)

const TAG = /^([a-z]{2,3})(?:[-_]([A-Z][a-z]{3}))?(?:[-_]([A-Z]{2}|[a-z]{2}|\d{3}))?$/

/** Normalized BCP 47 tag of `text` when it names a known language (`pt_BR` → `pt-BR`). */
export function localeTag(text: string): string | undefined {
  const match = TAG.exec(text)
  if (!match?.[1] || !LANGUAGES.has(match[1])) return undefined
  const script = match[2] ? `-${match[2]}` : ''
  const region = match[3] ? `-${match[3].toUpperCase()}` : ''
  return `${match[1]}${script}${region}`
}

const stripExtension = (name: string) => {
  const dot = name.indexOf('.')
  return dot === -1 ? { stem: name, ext: '' } : { stem: name.slice(0, dot), ext: name.slice(dot) }
}

/**
 * Locale of a catalog path by the usual layouts: a directory named after the locale
 * (`locales/ru/common.json`, `ru/LC_MESSAGES/app.po`), a file named after it (`ru.json`,
 * `ru.default.json`), or a locale suffix (`messages_ru.properties`, `strings.ru.yml`).
 */
export function locateCatalog(file: string): CatalogLocation | undefined {
  const parts = file.split('/')
  const name = parts.at(-1) ?? file
  const { stem, ext } = stripExtension(name)

  const own = localeTag(stem)
  if (own) {
    return { locale: own, bundle: [...parts.slice(0, -1), `{locale}${ext}`].join('/') }
  }

  for (let index = parts.length - 2; index >= 0; index--) {
    const locale = localeTag(parts[index] ?? '')
    if (!locale) continue
    const bundle = parts.map((part, i) => (i === index ? '{locale}' : part)).join('/')
    return { locale, namespace: stem, bundle }
  }

  const suffix = /^(.+?)[._-]([a-z]{2,3}(?:[-_][A-Za-z]{2,4})?)$/.exec(stem)
  const locale = suffix?.[2] ? localeTag(suffix[2]) : undefined
  if (suffix?.[1] && locale) {
    const dir = parts.slice(0, -1)
    const sep = stem.charAt(suffix[1].length)
    return {
      locale,
      namespace: suffix[1],
      bundle: [...dir, `${suffix[1]}${sep}{locale}${ext}`].join('/'),
    }
  }
  return undefined
}
