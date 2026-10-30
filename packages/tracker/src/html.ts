/** A table found in a document, with the nearest heading above it. */
export interface Table {
  heading?: string
  headers: string[]
  rows: string[][]
}

const entities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
}

/** Decodes named, decimal and hex character references. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, name: string) => {
    if (name.startsWith('#x')) return String.fromCodePoint(Number.parseInt(name.slice(2), 16))
    if (name.startsWith('#')) return String.fromCodePoint(Number(name.slice(1)))
    return entities[name] ?? whole
  })
}

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim()

const tokenPattern =
  /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<(\/?)([A-Za-z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)|</g

/** One tag or text run of an HTML or Confluence storage body. */
export type HtmlToken =
  | { type: 'text'; text: string }
  | { type: 'open'; name: string; attrs: Record<string, string>; selfClosing: boolean }
  | { type: 'close'; name: string }

/** Tags and decoded text runs of `html`, CDATA kept as text and comments dropped; never throws. */
export function tokenizeHtml(html: string): HtmlToken[] {
  const tokens: HtmlToken[] = []
  for (const match of html.matchAll(tokenPattern)) {
    const [whole, cdata, closing, name, rawAttrs, selfClosing, text] = match
    if (cdata !== undefined) tokens.push({ type: 'text', text: cdata })
    else if (name !== undefined) {
      const lower = name.toLowerCase()
      if (closing) tokens.push({ type: 'close', name: lower })
      else {
        const attrs: Record<string, string> = {}
        for (const attr of (rawAttrs ?? '').matchAll(
          /([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g,
        ))
          attrs[attr[1]!.toLowerCase()] = decodeEntities(attr[2] ?? attr[3] ?? attr[4] ?? '')
        tokens.push({
          type: 'open',
          name: lower,
          attrs,
          selfClosing: Boolean(selfClosing) || voidTags.has(lower),
        })
      }
    } else if (text !== undefined) tokens.push({ type: 'text', text: decodeEntities(text) })
    else if (whole === '<') tokens.push({ type: 'text', text: '<' })
  }
  return tokens
}

const voidTags = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'col', 'wbr'])
const breakTags = new Set(['br', 'p', 'div', 'li', 'ul', 'ol', 'tr', 'hr'])

/** Text a self-closing Confluence reference stands for: a user mention or a page link. */
function referenceText(name: string, attrs: Record<string, string>): string | undefined {
  if (name === 'ri:user') {
    const id = attrs['ri:account-id'] ?? attrs['ri:userkey'] ?? attrs['ri:username']
    return id ? `@${id}` : undefined
  }
  if (name === 'ri:page') return attrs['ri:content-title']
  return undefined
}

interface Cell {
  text: string
  header: boolean
  span: number
}

interface Row {
  cells: Cell[]
  head: boolean
}

interface OpenTable {
  heading?: string
  rows: Row[]
  row?: Row
  cell?: Cell
  inHead: boolean
}

function finishTable(table: OpenTable): Table {
  const rows = table.rows
    .filter((row) => row.cells.length)
    .map((row) => ({
      head: row.head || row.cells.every((cell) => cell.header),
      values: row.cells.flatMap((cell) =>
        Array.from({ length: cell.span }, () => collapse(cell.text)),
      ),
    }))
  const headerIndex = rows.findIndex((row) => row.head)
  const headerRow = headerIndex >= 0 ? rows[headerIndex] : rows[0]
  const headers = headerRow?.values ?? []
  const body = rows.filter((row) => row !== headerRow)
  return {
    ...(table.heading ? { heading: table.heading } : {}),
    headers,
    rows: body.map((row) =>
      headers.length > row.values.length
        ? [...row.values, ...Array.from({ length: headers.length - row.values.length }, () => '')]
        : row.values,
    ),
  }
}

/**
 * Tables of an HTML or Confluence storage body in document order, each with the text of the
 * closest heading before it. The header row is the `<thead>` row, else the first row made of
 * `<th>` cells, else the first row; `colspan` repeats a cell. Cell text is decoded and
 * whitespace-collapsed; user mentions become `@<account id>`. Never throws on malformed input.
 */
export function parseHtmlTables(html: string): Table[] {
  const done: Table[] = []
  const stack: OpenTable[] = []
  let heading: string | undefined
  let headingText: string | undefined
  const append = (text: string) => {
    if (headingText !== undefined) headingText += text
    const cell = stack.at(-1)?.cell
    if (cell) cell.text += text
  }
  for (const token of tokenizeHtml(html)) {
    const table = stack.at(-1)
    if (token.type === 'text') {
      append(token.text)
      continue
    }
    const { name } = token
    if (token.type === 'open') {
      if (/^h[1-6]$/.test(name)) headingText = ''
      else if (name === 'table') {
        stack.push({ ...(heading ? { heading } : {}), rows: [], inHead: false })
        continue
      } else if (table && name === 'thead') table.inHead = true
      else if (table && name === 'tr') {
        table.row = { cells: [], head: table.inHead }
        table.rows.push(table.row)
      } else if (table && (name === 'td' || name === 'th')) {
        if (!table.row) {
          table.row = { cells: [], head: table.inHead }
          table.rows.push(table.row)
        }
        const span = Math.min(Math.max(Number(token.attrs.colspan) || 1, 1), 50)
        table.cell = { text: '', header: name === 'th', span }
        table.row.cells.push(table.cell)
      }
      const reference = token.selfClosing ? referenceText(name, token.attrs) : undefined
      if (reference) append(reference)
      if (breakTags.has(name)) append(' ')
      continue
    }
    if (/^h[1-6]$/.test(name) && headingText !== undefined) {
      heading = collapse(headingText) || heading
      headingText = undefined
    } else if (name === 'table' && table) {
      stack.pop()
      done.push(finishTable(table))
    } else if (table && name === 'thead') table.inHead = false
    else if (table && name === 'tr') {
      delete table.row
      delete table.cell
    } else if (table && (name === 'td' || name === 'th')) delete table.cell
    else if (breakTags.has(name)) append(' ')
  }
  while (stack.length) done.push(finishTable(stack.pop()!))
  return done
}

/** Removes inline Markdown markup: code ticks, emphasis, links (keeping their text). */
export function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|\W)[*_]([^*_]+)[*_](?=\W|$)/g, '$1$2')
    .trim()
}

function splitRow(line: string): string[] {
  let text = line.trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1)
  return text.split(/(?<!\\)\|/).map((cell) => stripInlineMarkdown(cell.replaceAll('\\|', '|')))
}

/** GitHub-style pipe tables of a Markdown body, each with the closest heading before it. */
export function parseMarkdownTables(markdown: string): Table[] {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n')
  const tables: Table[] = []
  let heading: string | undefined
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const title = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)
    if (title) {
      heading = stripInlineMarkdown(title[1]!)
      continue
    }
    const separator = lines[index + 1]
    if (
      !line.includes('|') ||
      separator === undefined ||
      !/^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(separator)
    )
      continue
    const headers = splitRow(line)
    const rows: string[][] = []
    index += 2
    while (index < lines.length && lines[index]!.includes('|') && lines[index]!.trim()) {
      const cells = splitRow(lines[index]!)
      rows.push(headers.map((_, position) => cells[position] ?? ''))
      index++
    }
    index--
    tables.push({ ...(heading ? { heading } : {}), headers, rows })
  }
  return tables
}
