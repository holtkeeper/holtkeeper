/** One attribute as written, e.g. `onClick`, `:data-testid`, `@click.prevent`, `(click)`. */
export interface TagAttribute {
  name: string
  /** Literal value of a quoted or bare value; absent for expressions and valueless attributes. */
  value?: string
}

/** An opening tag found in a template. */
export interface ScannedTag {
  /** As written: `button`, `Button`, `S.Button`, `motion.a`, `el-button`. */
  name: string
  /** 1-based line of the `<`. */
  line: number
  attributes: TagAttribute[]
  /** Spread props or bound objects (`{...props}`, `v-bind="$attrs"`) may carry any attribute. */
  spread: boolean
}

/**
 * How a template is written: `jsx` for JSX/TSX (and tagged template literals inside them), `html`
 * for HTML-like templates (Vue, Svelte, Angular, plain HTML).
 */
export type TagSyntax = 'jsx' | 'html'

const NAME_START = /[A-Za-z_$]/
const NAME_CHAR = /[\w$.:-]/
const IDENT_CHAR = /[\w$]/
/** Keywords after which `<` starts JSX rather than a comparison or type argument. */
const JSX_AFTER_WORD = new Set(['return', 'yield', 'await', 'case', 'else', 'do', 'default'])
/** A tag longer than this is not a tag: the scanner hit a comparison and moves on. */
const MAX_TAG = 8000

function lineIndex(text: string): (offset: number) => number {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1)
  return (offset) => {
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if ((starts[mid] ?? 0) <= offset) low = mid
      else high = mid - 1
    }
    return low + 1
  }
}

/** Index after the string starting at `start` (its quote); handles escapes and `${}` in templates. */
function skipString(text: string, start: number): number {
  const quote = text[start]
  let i = start + 1
  while (i < text.length) {
    const char = text[i]
    if (char === '\\') i += 2
    else if (char === quote) return i + 1
    else if (quote === '`' && char === '$' && text[i + 1] === '{') i = skipBraces(text, i + 1)
    else i++
  }
  return text.length
}

/** Index after the `}` matching the `{` at `start`, skipping strings and comments. */
function skipBraces(text: string, start: number): number {
  let depth = 0
  let i = start
  while (i < text.length) {
    const char = text[i]
    if (char === '"' || char === "'" || char === '`') {
      i = skipString(text, i)
      continue
    }
    if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 2
      continue
    }
    if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) return i + 1
    }
    i++
  }
  return text.length
}

/** Whether `<` at `at` can open JSX, judging by what precedes it. */
function opensJsx(text: string, at: number): boolean {
  let i = at - 1
  while (i >= 0 && /\s/.test(text[i] ?? '')) i--
  if (i < 0) return true
  const before = text[i] ?? ''
  if (before === ')' || before === ']') return false
  if (!IDENT_CHAR.test(before)) return true
  let start = i
  while (start > 0 && IDENT_CHAR.test(text[start - 1] ?? '')) start--
  return JSX_AFTER_WORD.has(text.slice(start, i + 1))
}

interface Parsed {
  tag: ScannedTag
  end: number
  /** Ranges of `{…}` expressions inside the tag, scanned for nested tags. */
  inner: [number, number][]
}

function parseTag(text: string, at: number, syntax: TagSyntax, lineOf: (i: number) => number) {
  let i = at + 1
  const nameStart = i
  while (i < text.length && NAME_CHAR.test(text[i] ?? '')) i++
  const name = text.slice(nameStart, i)
  const tag: ScannedTag = { name, line: lineOf(at), attributes: [], spread: false }
  const inner: [number, number][] = []
  const limit = Math.min(text.length, at + MAX_TAG)
  while (i < limit) {
    const char = text[i] ?? ''
    if (/\s/.test(char)) {
      i++
      continue
    }
    if (char === '>') return { tag, end: i + 1, inner } satisfies Parsed
    if (char === '/' && text[i + 1] === '>') return { tag, end: i + 2, inner } satisfies Parsed
    if (char === '<') return undefined
    if (char === '{') {
      const end = skipBraces(text, i)
      const body = text.slice(i + 1, end - 1).trim()
      if (body.startsWith('...')) tag.spread = true
      else if (/^[A-Za-z_$][\w$]*$/.test(body)) tag.attributes.push({ name: body })
      inner.push([i + 1, end - 1])
      i = end
      continue
    }
    const attrStart = i
    while (i < limit && !/[\s=>/{"'`]/.test(text[i] ?? '')) i++
    if (i === attrStart) {
      i++
      continue
    }
    const attribute: TagAttribute = { name: text.slice(attrStart, i) }
    let j = i
    while (j < limit && /\s/.test(text[j] ?? '')) j++
    if (text[j] === '=') {
      j++
      while (j < limit && /\s/.test(text[j] ?? '')) j++
      const quote = text[j]
      if (quote === '"' || quote === "'") {
        const end = text.indexOf(quote, j + 1)
        if (end < 0) return undefined
        attribute.value = text.slice(j + 1, end)
        j = end + 1
      } else if (quote === '{' || (quote === '$' && text[j + 1] === '{')) {
        const open = quote === '{' ? j : j + 1
        const end = skipBraces(text, open)
        inner.push([open + 1, end - 1])
        j = end
      } else if (quote === '`') {
        j = skipString(text, j)
      } else {
        const valueStart = j
        while (j < limit && !/[\s>]/.test(text[j] ?? '')) j++
        attribute.value = text.slice(valueStart, j)
      }
      i = j
    }
    tag.attributes.push(attribute)
  }
  return undefined
}

/**
 * Finds opening tags in a template with a tolerant scanner: no parser, no type information. In
 * `jsx` syntax `<` opens a tag only where JSX can start (not after an identifier or `)`), so
 * comparisons and type arguments are skipped; tags inside attribute expressions are found too.
 * In `html` syntax comments and closing tags are skipped. Never throws on malformed input.
 */
export function scanTags(text: string, syntax: TagSyntax): ScannedTag[] {
  const lineOf = lineIndex(text)
  const found: ScannedTag[] = []
  const scan = (from: number, to: number) => {
    let i = from
    while (i < to) {
      const char = text[i]
      if (syntax === 'jsx' && char === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2)
        i = end < 0 ? to : end + 2
        continue
      }
      if (
        syntax === 'jsx' &&
        char === '/' &&
        text[i + 1] === '/' &&
        /(^|[\s;{}(),])$/.test(text.slice(Math.max(0, i - 1), i))
      ) {
        const end = text.indexOf('\n', i)
        i = end < 0 ? to : end
        continue
      }
      if (syntax === 'html' && text.startsWith('<!--', i)) {
        const end = text.indexOf('-->', i + 4)
        i = end < 0 ? to : end + 3
        continue
      }
      if (
        char !== '<' ||
        !NAME_START.test(text[i + 1] ?? '') ||
        (syntax === 'jsx' && !opensJsx(text, i))
      ) {
        i++
        continue
      }
      const parsed = parseTag(text, i, syntax, lineOf)
      if (!parsed) {
        i++
        continue
      }
      found.push(parsed.tag)
      for (const [start, end] of parsed.inner) scan(start, end)
      i = parsed.end
    }
  }
  scan(0, text.length)
  return found.toSorted((a, b) => a.line - b.line)
}

const blank = (part: string) => part.replace(/[^\n]/g, ' ')

/** `text` with the bodies of the given blocks (e.g. `script`, `style`) blanked, lines kept. */
export function blankBlocks(text: string, names: readonly string[]): string {
  let result = text
  for (const name of names) {
    const pattern = new RegExp(`<${name}\\b[^>]*>[\\s\\S]*?</${name}\\s*>`, 'gi')
    result = result.replace(pattern, blank)
  }
  return result
}

/** `text` with everything outside the outermost `<template>` block blanked, lines kept. */
export function onlyTemplate(text: string): string {
  const open = /^<template\b[^>]*>/m.exec(text)
  const close = text.lastIndexOf('</template>')
  if (!open || close < open.index) return ''
  const start = open.index + open[0].length
  return blank(text.slice(0, start)) + text.slice(start, close) + blank(text.slice(close))
}
