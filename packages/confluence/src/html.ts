import { decodeEntities, escapeAttribute, escapeText, safeHref, VOID } from './xml.ts'

const RENAME: Record<string, string> = { b: 'strong', i: 'em', strike: 'del' }

const ALLOWED = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'strong',
  'em',
  'u',
  's',
  'del',
  'sub',
  'sup',
  'code',
  'pre',
  'blockquote',
  'a',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'br',
  'hr',
])

const DROP_WITH_CONTENT = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'template',
  'noscript',
  'svg',
  'math',
  'head',
  'title',
  'textarea',
  'select',
])

const BLOCK = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'table',
  'hr',
])

/** For an element that opens, the open elements it implicitly closes, and where the search stops. */
const IMPLIED: Record<string, { closes: string[]; stop: string[] }> = {
  li: { closes: ['li'], stop: ['ul', 'ol'] },
  tr: { closes: ['tr', 'td', 'th'], stop: ['table', 'thead', 'tbody'] },
  td: { closes: ['td', 'th'], stop: ['tr', 'table'] },
  th: { closes: ['td', 'th'], stop: ['tr', 'table'] },
  thead: { closes: ['thead', 'tbody', 'tr', 'td', 'th'], stop: ['table'] },
  tbody: { closes: ['thead', 'tbody', 'tr', 'td', 'th'], stop: ['table'] },
}

const TOKEN =
  /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[([\s\S]*?)(?:\]\]>|$)|<[!?][^>]*>|<(\/?)([a-zA-Z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g
const ATTRIBUTE = /([^\s"'=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g

function attributes(raw: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const match of raw.matchAll(ATTRIBUTE)) {
    const name = match[1]!.toLowerCase()
    if (!out.has(name)) out.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ''))
  }
  return out
}

function renderAttributes(tag: string, raw: string): string {
  const attrs = attributes(raw)
  if (tag === 'a') {
    const href = safeHref(attrs.get('href') ?? '')
    return href === undefined ? '' : ` href="${escapeAttribute(href)}"`
  }
  if (tag === 'td' || tag === 'th') {
    let out = ''
    for (const name of ['colspan', 'rowspan']) {
      const value = attrs.get(name)
      if (value !== undefined && /^\d{1,3}$/.test(value) && Number(value) > 0)
        out += ` ${name}="${value}"`
    }
    return out
  }
  return ''
}

/**
 * Reduces HTML to the storage-format subset: headings, paragraphs, inline formatting, links,
 * lists, tables, `pre`, quotes, `br` and `hr`. Scripts, styles and embedded content are dropped with
 * their contents; other unknown elements are unwrapped; every attribute except `href` (http(s),
 * mailto, relative) and table spans is removed. The result is well-formed XHTML.
 */
export function sanitizeHtml(html: string): string {
  const stack: string[] = []
  let out = ''
  let dropping: string | undefined
  let depth = 0
  let last = 0

  const close = (tag: string) => {
    const at = stack.lastIndexOf(tag)
    if (at === -1) return
    while (stack.length > at) out += `</${stack.pop()}>`
  }

  const text = (raw: string) => {
    if (dropping || raw === '') return
    out += escapeText(decodeEntities(raw))
  }

  for (const match of html.matchAll(TOKEN)) {
    text(html.slice(last, match.index))
    last = match.index + match[0].length
    if (match[1] !== undefined) {
      text(match[1].replaceAll('&', '&amp;'))
      continue
    }
    const name = match[3]?.toLowerCase()
    if (!name) continue
    const closing = match[2] === '/'

    if (dropping) {
      if (name === dropping) depth += closing ? -1 : match[0].endsWith('/>') ? 0 : 1
      if (depth === 0) dropping = undefined
      continue
    }
    if (DROP_WITH_CONTENT.has(name)) {
      if (!closing && !match[0].endsWith('/>')) {
        dropping = name
        depth = 1
      }
      continue
    }

    const tag = RENAME[name] ?? name
    if (!ALLOWED.has(tag)) continue

    if (closing) {
      if (!VOID.has(tag)) close(tag)
      continue
    }

    const implied = IMPLIED[tag]
    if (implied) {
      for (let at = stack.length - 1; at >= 0; at--) {
        const open = stack[at]!
        if (implied.stop.includes(open)) break
        if (implied.closes.includes(open)) {
          close(open)
          break
        }
      }
    }
    if (BLOCK.has(tag) && stack.includes('p')) close('p')

    if (VOID.has(tag)) {
      out += `<${tag} />`
      continue
    }
    out += `<${tag}${renderAttributes(tag, match[4] ?? '')}>`
    stack.push(tag)
  }
  text(html.slice(last))
  while (stack.length > 0) out += `</${stack.pop()}>`
  return out
}
