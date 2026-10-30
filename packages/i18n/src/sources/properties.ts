import { locateCatalog } from '../locate.ts'
import type { CatalogEntry, CatalogLocation, CatalogSource } from '../types.ts'
import { insertBlocks, type LineSpan, removeBlocks } from './lines.ts'

/** Locale of a `.properties` file without a locale suffix: the bundle's default. */
export const DEFAULT_LOCALE = 'und'

const unescape = (text: string) =>
  text.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, escaped: string) => {
    if (escaped.length === 5) return String.fromCharCode(Number.parseInt(escaped.slice(1), 16))
    return escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped
  })

const escapeValue = (text: string, ascii: boolean) => {
  const escaped = text
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/^ /, '\\ ')
  return ascii
    ? escaped.replace(
        /[\u0080-\uffff]/g,
        (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
      )
    : escaped
}

const escapeKey = (key: string) => key.replace(/([=: \\])/g, '\\$1')

interface PropertiesEntry extends CatalogEntry {
  end: number
  separator: string
}

function parseEntries(text: string): PropertiesEntry[] {
  const lines = text.split(/\r?\n/)
  const entries: PropertiesEntry[] = []
  for (let index = 0; index < lines.length; index++) {
    const first = lines[index]!
    const trimmed = first.trimStart()
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('!')) continue
    const start = index
    let logical = trimmed
    while (/(^|[^\\])(\\\\)*\\$/.test(logical) && index + 1 < lines.length) {
      index++
      logical = logical.slice(0, -1) + lines[index]!.trimStart()
    }
    const match = /^((?:\\.|[^\s=:\\])+)(\s*[=:]\s*|\s+)?(.*)$/.exec(logical)
    if (!match?.[1]) continue
    entries.push({
      key: unescape(match[1]),
      value: unescape(match[3] ?? ''),
      line: start + 1,
      end: index + 1,
      separator: match[2] ?? '=',
    })
  }
  return entries
}

const spansOf = (text: string): LineSpan[] =>
  parseEntries(text).map((entry) => ({ key: entry.key, start: entry.line, end: entry.end }))

function locateProperties(file: string): CatalogLocation | undefined {
  const located = locateCatalog(file)
  if (located) return located
  const parts = file.split('/')
  const name = parts.at(-1) ?? file
  const stem = name.replace(/\.properties$/i, '')
  return {
    locale: DEFAULT_LOCALE,
    namespace: stem,
    bundle: [...parts.slice(0, -1), `${stem}_{locale}.properties`].join('/'),
  }
}

/** Java/Kotlin resource bundles: `messages.properties`, `messages_ru.properties`. */
export const propertiesSource = (): CatalogSource => ({
  format: 'properties',
  matches: (file) =>
    /\.properties$/i.test(file) && !/(^|\/)(gradle|local|application)[^/]*$/i.test(file),
  locate: locateProperties,
  parse: (text) => ({
    entries: parseEntries(text).map(({ end: _end, separator: _separator, ...entry }) => entry),
  }),
  insert(text, inserts, order) {
    const separator = parseEntries(text)[0]?.separator ?? '='
    const ascii = !/[\u0080-\uffff]/.test(text)
    const blocks = inserts.map((insert) => ({
      key: insert.key,
      lines: [`${escapeKey(insert.key)}${separator}${escapeValue(insert.value, ascii)}`],
    }))
    return insertBlocks(text, blocks, order, spansOf, false)
  },
  remove: (text, keys) => removeBlocks(text, keys, spansOf, false),
})
