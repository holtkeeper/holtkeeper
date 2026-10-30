/** Escapes text for an XHTML text node. */
export const escapeText = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

/** Escapes text for a double-quoted XHTML attribute. */
export const escapeAttribute = (value: string) => escapeText(value).replaceAll('"', '&quot;')

/** Wraps text in CDATA, splitting any `]]>` it contains. */
export const cdata = (value: string) => `<![CDATA[${value.replaceAll(']]>', ']]]]><![CDATA[>')}]]>`

/** U+00A0, spelled out because formatters turn the escape into an invisible literal. */
export const NBSP = String.fromCharCode(0xa0)

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: NBSP,
}

/** Decodes numeric and the basic named entities; unknown entities stay as written. */
export function decodeEntities(value: string): string {
  return value.replaceAll(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? parseInt(entity.slice(2), 16)
          : Number(entity.slice(1))
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match
    }
    return NAMED[entity.toLowerCase()] ?? match
  })
}

const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:'])

/** Returns `href` when it is relative or uses http(s)/mailto, `undefined` otherwise. */
export function safeHref(href: string): string | undefined {
  const trimmed = href.trim()
  if (trimmed === '') return undefined
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed.replaceAll(/[\s\p{Cc}]/gu, ''))
  if (!scheme) return trimmed
  return SAFE_SCHEMES.has(`${scheme[1]!.toLowerCase()}:`) ? trimmed : undefined
}

const TOKEN =
  /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!(?:[^>"']|"[^"]*"|'[^']*')*>|<\/?([a-zA-Z][\w:.-]*)(?:[^>"']|"[^"]*"|'[^']*')*>/g

/**
 * Whether every element opened in `markup` is closed in it, in order. Void HTML elements written
 * without a slash are tolerated. Used to refuse edits that would break the page's XHTML.
 */
export function isBalanced(markup: string): boolean {
  const stack: string[] = []
  for (const match of markup.matchAll(TOKEN)) {
    const name = match[1]
    if (!name) continue
    const tag = match[0]
    if (tag.endsWith('/>')) continue
    const lower = name.toLowerCase()
    if (tag.startsWith('</')) {
      if (stack.pop() !== lower) return false
    } else if (!VOID.has(lower)) stack.push(lower)
  }
  return stack.length === 0
}

export const VOID = new Set(['br', 'hr', 'img', 'col', 'wbr'])
