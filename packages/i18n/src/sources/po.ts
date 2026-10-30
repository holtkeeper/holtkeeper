import { locateCatalog } from '../locate.ts'
import type { CatalogEntry, CatalogInsert, CatalogSource, ParsedCatalog } from '../types.ts'
import { insertBlocks, type LineSpan, removeBlocks } from './lines.ts'

/** Separates `msgctxt` from `msgid` in keys, as gettext does in compiled catalogs. */
export const CONTEXT_SEPARATOR = '\u0004'

interface PoEntry extends CatalogEntry {
  end: number
  header: boolean
}

const unquote = (text: string) => {
  const inner = text.trim().replace(/^"|"$/g, '')
  return inner.replace(/\\(.)/g, (_, char: string) =>
    char === 'n' ? '\n' : char === 't' ? '\t' : char === 'r' ? '\r' : char,
  )
}

const quote = (text: string) =>
  `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t')}"`

function parseEntries(text: string): PoEntry[] {
  const lines = text.split(/\r?\n/)
  const entries: PoEntry[] = []
  let block: { start: number; end: number; lines: string[] } | undefined
  const flush = () => {
    if (!block) return
    const entry = entryOf(block.lines, block.start, block.end)
    if (entry) entries.push(entry)
    block = undefined
  }
  lines.forEach((line, index) => {
    if (line.trim() === '') return flush()
    if (line.startsWith('#~')) return
    block ??= { start: index + 1, end: index + 1, lines: [] }
    block.end = index + 1
    block.lines.push(line)
  })
  flush()
  return entries
}

function entryOf(lines: string[], start: number, end: number): PoEntry | undefined {
  const fields = new Map<string, string>()
  let current: string | undefined
  let fuzzy = false
  for (const line of lines) {
    if (line.startsWith('#,')) fuzzy ||= /\bfuzzy\b/.test(line)
    if (line.startsWith('#')) continue
    const field = /^(msgctxt|msgid_plural|msgid|msgstr(?:\[\d+\])?)\s+(".*")\s*$/.exec(line)
    if (field?.[1] && field[2] !== undefined) {
      current = field[1]
      fields.set(current, unquote(field[2]))
    } else if (current && line.trim().startsWith('"')) {
      fields.set(current, (fields.get(current) ?? '') + unquote(line))
    }
  }
  const id = fields.get('msgid')
  if (id === undefined) return undefined
  const context = fields.get('msgctxt')
  const plural = fields.get('msgid_plural')
  const forms = [...fields.entries()]
    .filter(([name]) => name.startsWith('msgstr['))
    .toSorted(([a], [b]) => Number(/\d+/.exec(a)?.[0]) - Number(/\d+/.exec(b)?.[0]))
    .map(([, value]) => value)
  return {
    key: context === undefined ? id : `${context}${CONTEXT_SEPARATOR}${id}`,
    value: plural === undefined ? (fields.get('msgstr') ?? '') : (forms[0] ?? ''),
    source: id,
    ...(plural === undefined ? {} : { plural, forms }),
    ...(fuzzy ? { fuzzy } : {}),
    line: start,
    end,
    header: id === '' && context === undefined,
  }
}

/** Entries and header facts of a gettext `.po` file; the header entry is not an entry. */
export function parsePo(text: string): ParsedCatalog {
  const all = parseEntries(text)
  const header = all.find((entry) => entry.header)?.value ?? ''
  const plural = /^Plural-Forms:.*nplurals\s*=\s*(\d+)/im.exec(header)?.[1]
  const language = /^Language:\s*([\w-]+)/im.exec(header)?.[1]
  return {
    entries: all
      .filter((entry) => !entry.header)
      .map(({ end: _end, header: _header, ...entry }) => entry),
    ...(plural ? { pluralForms: Number(plural) } : {}),
    ...(language ? { locale: language } : {}),
  }
}

const spansOf = (text: string): LineSpan[] =>
  parseEntries(text)
    .filter((entry) => !entry.header)
    .map((entry) => ({ key: entry.key, start: entry.line, end: entry.end }))

function entryLines(insert: CatalogInsert, forms: number): string[] {
  const separator = insert.key.indexOf(CONTEXT_SEPARATOR)
  const context = separator === -1 ? undefined : insert.key.slice(0, separator)
  const id = separator === -1 ? insert.key : insert.key.slice(separator + 1)
  const plural = insert.base?.plural
  const lines = insert.value ? ['#, fuzzy'] : []
  if (context !== undefined) lines.push(`msgctxt ${quote(context)}`)
  lines.push(`msgid ${quote(id)}`)
  if (plural === undefined) lines.push(`msgstr ${quote(insert.value)}`)
  else {
    lines.push(`msgid_plural ${quote(plural)}`)
    const values = insert.forms ?? []
    for (let i = 0; i < Math.max(forms, 1); i++)
      lines.push(`msgstr[${i}] ${quote(values[i] ?? insert.value)}`)
  }
  return lines
}

/** gettext `.po` catalogs: `<lng>.po`, `<lng>/LC_MESSAGES/<domain>.po`; plurals by index. */
export const poSource = (): CatalogSource => ({
  format: 'po',
  matches: (file) => /\.po$/i.test(file),
  locate: locateCatalog,
  parse: parsePo,
  insert(text, inserts, order) {
    const forms = parsePo(text).pluralForms ?? 2
    const blocks = inserts.map((insert) => ({ key: insert.key, lines: entryLines(insert, forms) }))
    return insertBlocks(text, blocks, order, spansOf, true)
  },
  remove: (text, keys) => removeBlocks(text, keys, spansOf, true),
})
