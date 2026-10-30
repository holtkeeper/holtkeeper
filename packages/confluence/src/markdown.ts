import { cdata, escapeAttribute, escapeText, safeHref } from './xml.ts'

const PUNCTUATION = /[!"#$%&'()*+,./:;<=>?@[\\\]^_`{|}~-]/
const isWordChar = (char: string | undefined) => char !== undefined && /[\p{L}\p{N}]/u.test(char)

function findClosing(text: string, delimiter: string, from: number): number {
  for (let index = from; index <= text.length - delimiter.length; index++) {
    if (text[index] === '\\') {
      index++
      continue
    }
    if (text[index] === '`') {
      const run = /^`+/.exec(text.slice(index))![0]
      const end = text.indexOf(run, index + run.length)
      if (end !== -1) index = end + run.length - 1
      continue
    }
    if (!text.startsWith(delimiter, index)) continue
    if (index === from || /\s/.test(text[index - 1]!)) continue
    if (delimiter[0] === '_' && isWordChar(text[index + delimiter.length])) continue
    return index
  }
  return -1
}

function findBracket(text: string, from: number): number {
  let depth = 0
  for (let index = from; index < text.length; index++) {
    const char = text[index]
    if (char === '\\') index++
    else if (char === '[') depth++
    else if (char === ']') {
      if (depth === 0) return index
      depth--
    }
  }
  return -1
}

function link(label: string, href: string): string {
  const safe = safeHref(href)
  if (safe === undefined) return label
  return `<a href="${escapeAttribute(safe)}">${label}</a>`
}

/** Renders inline Markdown (emphasis, code, links, breaks) as storage XHTML; raw HTML is escaped. */
function renderInline(text: string): string {
  let out = ''
  let index = 0
  while (index < text.length) {
    const char = text[index]!
    const rest = text.slice(index)

    if (char === '\\' && index + 1 < text.length) {
      const next = text[index + 1]!
      if (next === '\n') {
        out += '<br />'
        index += 2
        continue
      }
      if (PUNCTUATION.test(next)) {
        out += escapeText(next)
        index += 2
        continue
      }
    }

    if (char === '`') {
      const run = /^`+/.exec(rest)![0]
      const end = text.indexOf(run, index + run.length)
      if (end !== -1) {
        let code = text.slice(index + run.length, end).replaceAll('\n', ' ')
        if (/^ .* $/.test(code) && code.trim() !== '') code = code.slice(1, -1)
        out += `<code>${escapeText(code)}</code>`
        index = end + run.length
        continue
      }
      out += escapeText(run)
      index += run.length
      continue
    }

    if (char === '<') {
      const auto = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(rest)
      if (auto) {
        out += link(escapeText(auto[1]!), auto[1]!)
        index += auto[0].length
        continue
      }
    }

    if (char === '[') {
      const close = findBracket(text, index + 1)
      if (close !== -1 && text[close + 1] === '(') {
        const target =
          /^\(\s*(<[^>]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:\s+"[^"]*"|\s+'[^']*')?\s*\)/.exec(
            text.slice(close + 1),
          )
        if (target) {
          const href = target[1]!.replace(/^<(.*)>$/, '$1')
          out += link(renderInline(text.slice(index + 1, close)), href)
          index = close + 1 + target[0].length
          continue
        }
      }
    }

    const delimiter =
      ['**', '__', '~~'].find((d) => rest.startsWith(d)) ??
      (char === '*' || char === '_' ? char : undefined)
    if (
      delimiter &&
      text[index + delimiter.length] !== undefined &&
      !/\s/.test(text[index + delimiter.length]!)
    ) {
      const intraword = delimiter[0] === '_' && isWordChar(text[index - 1])
      const end = intraword ? -1 : findClosing(text, delimiter, index + delimiter.length)
      if (end !== -1) {
        const inner = renderInline(text.slice(index + delimiter.length, end))
        const tag = delimiter === '~~' ? 'del' : delimiter.length === 2 ? 'strong' : 'em'
        out += `<${tag}>${inner}</${tag}>`
        index = end + delimiter.length
        continue
      }
    }

    if (char === '\n') {
      out = `${out.trimEnd()}${/ {2}$/.test(out) ? '<br />' : ' '}`
      index++
      continue
    }

    out += escapeText(char)
    index++
  }
  return out.trimEnd()
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?(?:\s+#+)?\s*$/
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])(?: +(.*))?$/
const QUOTE = /^ {0,3}> ?(.*)$/
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/

const blank = (line: string | undefined) => line === undefined || line.trim() === ''

function splitRow(line: string): string[] {
  let row = line.trim()
  if (row.startsWith('|')) row = row.slice(1)
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1)
  const cells: string[] = []
  let cell = ''
  for (let index = 0; index < row.length; index++) {
    if (row[index] === '\\' && row[index + 1] === '|') {
      cell += '|'
      index++
    } else if (row[index] === '|') {
      cells.push(cell.trim())
      cell = ''
    } else cell += row[index]
  }
  cells.push(cell.trim())
  return cells
}

const LANGUAGE = /^[a-z0-9+#._-]{1,32}$/i

function codeMacro(code: string, language: string): string {
  const parameter = LANGUAGE.test(language)
    ? `<ac:parameter ac:name="language">${escapeText(language.toLowerCase())}</ac:parameter>`
    : ''
  return `<ac:structured-macro ac:name="code">${parameter}<ac:plain-text-body>${cdata(code)}</ac:plain-text-body></ac:structured-macro>`
}

function startsBlock(line: string, next: string | undefined): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    LIST_ITEM.test(line) ||
    (line.includes('|') && next !== undefined && TABLE_SEPARATOR.test(next) && next.includes('-'))
  )
}

function renderBlocks(lines: string[]): string {
  const out: string[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]!
    if (blank(line)) {
      index++
      continue
    }

    const fence = FENCE.exec(line)
    if (fence) {
      const marker = fence[1]!
      const body: string[] = []
      index++
      while (
        index < lines.length &&
        !new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[index]!)
      ) {
        body.push(lines[index]!)
        index++
      }
      index++
      out.push(codeMacro(body.join('\n'), fence[2]!))
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      const level = heading[1]!.length
      out.push(`<h${level}>${renderInline(heading[2] ?? '')}</h${level}>`)
      index++
      continue
    }

    if (RULE.test(line)) {
      out.push('<hr />')
      index++
      continue
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = []
      while (index < lines.length && QUOTE.test(lines[index]!)) {
        quoted.push(QUOTE.exec(lines[index]!)![1]!)
        index++
      }
      out.push(`<blockquote>${renderBlocks(quoted)}</blockquote>`)
      continue
    }

    const next = lines[index + 1]
    if (
      line.includes('|') &&
      next !== undefined &&
      TABLE_SEPARATOR.test(next) &&
      next.includes('-')
    ) {
      const header = splitRow(line)
      const align = splitRow(next).map((cell) =>
        cell.startsWith(':') && cell.endsWith(':')
          ? 'center'
          : cell.endsWith(':')
            ? 'right'
            : cell.startsWith(':')
              ? 'left'
              : undefined,
      )
      const cell = (tag: 'th' | 'td', text: string, column: number) => {
        const alignment = align[column]
        const style = alignment ? ` style="text-align: ${alignment};"` : ''
        return `<${tag}${style}>${renderInline(text)}</${tag}>`
      }
      index += 2
      const rows: string[] = []
      while (index < lines.length && !blank(lines[index]) && lines[index]!.includes('|')) {
        const cells = splitRow(lines[index]!)
        rows.push(
          `<tr>${header.map((_, column) => cell('td', cells[column] ?? '', column)).join('')}</tr>`,
        )
        index++
      }
      const head = `<tr>${header.map((text, column) => cell('th', text, column)).join('')}</tr>`
      out.push(`<table><tbody>${head}${rows.join('')}</tbody></table>`)
      continue
    }

    if (LIST_ITEM.test(line)) {
      index = renderList(lines, index, out)
      continue
    }

    const paragraph: string[] = []
    while (
      index < lines.length &&
      !blank(lines[index]) &&
      (paragraph.length === 0 || !startsBlock(lines[index]!, lines[index + 1]))
    ) {
      paragraph.push(lines[index]!.trimStart())
      index++
    }
    out.push(`<p>${renderInline(paragraph.join('\n'))}</p>`)
  }
  return out.join('')
}

function renderList(lines: string[], start: number, out: string[]): number {
  const first = LIST_ITEM.exec(lines[start]!)!
  const indent = first[1]!.length
  const ordered = /\d/.test(first[2]!)
  const items: string[] = []
  let index = start
  while (index < lines.length) {
    const match = LIST_ITEM.exec(lines[index]!)
    if (!match || match[1]!.length !== indent || /\d/.test(match[2]!) !== ordered) break
    const contentIndent = indent + match[2]!.length + 1
    const body = [match[3] ?? '']
    index++
    while (index < lines.length) {
      const current = lines[index]!
      if (blank(current)) {
        const following = lines[index + 1]
        if (
          following !== undefined &&
          !blank(following) &&
          /^ */.exec(following)![0].length > indent
        ) {
          body.push('')
          index++
          continue
        }
        break
      }
      const leading = /^ */.exec(current)![0].length
      if (leading <= indent) break
      body.push(current.slice(Math.min(leading, contentIndent)))
      index++
    }
    items.push(renderItem(body))
    if (
      blank(lines[index]) &&
      LIST_ITEM.test(lines[index + 1] ?? '') &&
      LIST_ITEM.exec(lines[index + 1]!)![1]!.length === indent
    )
      index++
  }
  const tag = ordered ? 'ol' : 'ul'
  out.push(`<${tag}>${items.map((item) => `<li>${item}</li>`).join('')}</${tag}>`)
  return index
}

function renderItem(body: string[]): string {
  const rendered = renderBlocks(body)
  return rendered.replace(/^<p>([\s\S]*?)<\/p>(?=<(?:ul|ol)>|$)/, (whole, inner: string) =>
    inner.includes('</p>') ? whole : inner,
  )
}

/**
 * Converts Markdown (CommonMark subset plus GFM tables and strikethrough) to Confluence storage
 * XHTML. All text is escaped, raw HTML is shown as text, and only http(s), mailto and relative links
 * are kept. Fenced code becomes the `code` macro.
 */
export function markdownToStorage(markdown: string): string {
  return renderBlocks(markdown.replaceAll('\r\n', '\n').replaceAll('\t', '    ').split('\n'))
}
