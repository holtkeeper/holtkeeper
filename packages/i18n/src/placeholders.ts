/** An ICU `plural` or `selectordinal` argument and the branches it defines. */
export interface IcuPlural {
  argument: string
  kind: 'plural' | 'selectordinal'
  /** Branch selectors as written: `one`, `other`, `=0`. */
  selectors: string[]
}

/** Placeholders of one message, in the notations translators must keep. */
export interface MessageShape {
  /** Every placeholder occurrence, e.g. `{{name}}`, `{count}`, `%s`, `<0>`; duplicates kept. */
  tokens: string[]
  plurals: IcuPlural[]
}

const I18NEXT = /\{\{-?\s*([^{}]*?)\s*\}\}/g
const PRINTF =
  /%(?:\d+\$)?(?:\([\w.]+\))?[-+0#]*\d*(?:\.\d+)?(?:hh|h|ll|l|L|z|j|t)?[sdifuxXoeEgGcp@]/g
const TAG = /<([\w.-]+)(?:\s[^<>]*?)?\s*\/?>/g

interface IcuResult {
  args: string[]
  plurals: IcuPlural[]
}

function parseIcu(text: string): IcuResult {
  const result: IcuResult = { args: [], plurals: [] }
  let index = 0

  const skipQuoted = () => {
    const next = text[index + 1]
    if (next === "'") {
      index += 2
      return true
    }
    if (next === '{' || next === '}' || next === '#' || next === '|') {
      const end = text.indexOf("'", index + 1)
      index = end === -1 ? text.length : end + 1
      return true
    }
    return false
  }

  const readUntil = (stops: string) => {
    const start = index
    while (index < text.length && !stops.includes(text[index]!)) index++
    return text.slice(start, index).trim()
  }

  const skipBalanced = () => {
    let depth = 1
    while (index < text.length && depth > 0) {
      const char = text[index]
      if (char === '{') depth++
      else if (char === '}') depth--
      index++
    }
  }

  const message = (nested: boolean): void => {
    while (index < text.length) {
      const char = text[index]!
      if (char === "'" && skipQuoted()) continue
      if (char === '}' && nested) return
      if (char === '{') {
        index++
        argument()
        continue
      }
      index++
    }
  }

  const argument = () => {
    const name = readUntil(',}')
    if (!/^[\p{L}\p{N}_$.-]+$/u.test(name)) {
      skipBalanced()
      return
    }
    result.args.push(name)
    if (text[index] === '}') {
      index++
      return
    }
    index++
    const type = readUntil(',}')
    if (text[index] === '}') {
      index++
      return
    }
    index++
    if (type !== 'plural' && type !== 'selectordinal' && type !== 'select') {
      skipBalanced()
      return
    }
    const selectors: string[] = []
    for (;;) {
      while (index < text.length && /\s/.test(text[index]!)) index++
      if (index >= text.length) return
      if (text[index] === '}') {
        index++
        break
      }
      const selector = readUntil('{}')
      if (text[index] !== '{') break
      index++
      const last = selector.split(/\s+/).at(-1) ?? selector
      if (last && !last.startsWith('offset:')) selectors.push(last)
      message(true)
      index++
    }
    if (type !== 'select') result.plurals.push({ argument: name, kind: type, selectors })
  }

  try {
    message(false)
  } catch {
    // Malformed messages keep whatever was parsed before the error.
  }
  return result
}

/** Placeholders and ICU plurals of a message in any of the common notations. */
export function messageShape(text: string): MessageShape {
  const tokens: string[] = []
  const withoutI18next = text.replace(I18NEXT, (_, inner: string) => {
    const name = inner.split(',')[0]?.trim() ?? inner
    tokens.push(`{{${name}}}`)
    return ' '
  })
  const withoutTags = withoutI18next.replace(TAG, (_, name: string) => {
    tokens.push(`<${name}>`)
    return ' '
  })
  for (const match of withoutTags.replaceAll('%%', '').matchAll(PRINTF)) tokens.push(match[0])
  const icu = parseIcu(withoutTags)
  for (const arg of icu.args) tokens.push(`{${arg}}`)
  return { tokens, plurals: icu.plurals }
}

const positional = (token: string) => token.startsWith('%') && !token.includes('$')

const counts = (tokens: readonly string[]) => {
  const map = new Map<string, number>()
  for (const token of tokens) map.set(token, (map.get(token) ?? 0) + 1)
  return map
}

/**
 * Placeholder differences between a base message and its translation. Repeats matter for
 * positional notations (`%s`) only; named placeholders may be repeated or reordered freely.
 */
export function comparePlaceholders(
  base: readonly string[],
  translation: readonly string[],
): { missing: string[]; unexpected: string[] } {
  const want = counts(base)
  const have = counts(translation)
  const missing: string[] = []
  const unexpected: string[] = []
  for (const [token, count] of want) {
    const got = have.get(token) ?? 0
    if (got === 0 || (positional(token) && got < count)) missing.push(token)
  }
  for (const [token, count] of have) {
    const wanted = want.get(token) ?? 0
    if (wanted === 0 || (positional(token) && count > wanted)) unexpected.push(token)
  }
  return { missing, unexpected }
}

/** The text of a message without placeholders, for "is this really translatable" heuristics. */
export const stripPlaceholders = (text: string) =>
  text
    .replace(I18NEXT, ' ')
    .replace(TAG, ' ')
    .replace(PRINTF, ' ')
    .replace(/\{[^{}]*\}/g, ' ')
