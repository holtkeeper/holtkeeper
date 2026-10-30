/**
 * Shape of a name. `flatcase` (`count`) and `UPPERCASE` (`MAX`) are single words that fit more
 * than one multi-word style; `mixed` fits none.
 */
export type CaseStyle =
  | 'camelCase'
  | 'PascalCase'
  | 'SCREAMING_SNAKE_CASE'
  | 'snake_case'
  | 'kebab-case'
  | 'flatcase'
  | 'UPPERCASE'
  | 'mixed'

/** Styles a name can be rewritten into with `toCase`. */
export const CASE_STYLES: readonly CaseStyle[] = [
  'camelCase',
  'PascalCase',
  'SCREAMING_SNAKE_CASE',
  'snake_case',
  'kebab-case',
  'flatcase',
  'UPPERCASE',
]

const AFFIX = /^([_$]*)(.*?)([_$]*)$/s

function core(name: string): { prefix: string; body: string; suffix: string } {
  const [, prefix = '', body = '', suffix = ''] = AFFIX.exec(name) ?? []
  return { prefix, body, suffix }
}

/**
 * Classifies a name, ignoring leading and trailing `_` and `$` (`_cache`, `$el`, `class_`).
 * Returns `undefined` for names with nothing left to classify (`_`, `$`, `__`).
 */
export function classifyCase(name: string): CaseStyle | undefined {
  const { body } = core(name)
  if (!body) return undefined
  if (/^[a-z][a-z0-9]*$/.test(body)) return 'flatcase'
  if (/^[A-Z][A-Z0-9]*$/.test(body)) return 'UPPERCASE'
  if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(body)) return 'snake_case'
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(body)) return 'SCREAMING_SNAKE_CASE'
  if (/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(body)) return 'kebab-case'
  if (/^[a-z][a-zA-Z0-9]*$/.test(body)) return 'camelCase'
  if (/^[A-Z][a-zA-Z0-9]*$/.test(body)) return 'PascalCase'
  return 'mixed'
}

/**
 * Styles a name of the given shape is consistent with. A single lowercase word fits camelCase,
 * snake_case and kebab-case alike; a single uppercase word fits SCREAMING_SNAKE_CASE, and one
 * capital letter (`T`) also fits PascalCase.
 */
export function compatibleStyles(name: string): readonly CaseStyle[] {
  const style = classifyCase(name)
  if (style === undefined || style === 'mixed') return []
  if (style === 'flatcase') return ['flatcase', 'camelCase', 'snake_case', 'kebab-case']
  if (style === 'UPPERCASE') {
    return core(name).body.length === 1
      ? ['UPPERCASE', 'SCREAMING_SNAKE_CASE', 'PascalCase']
      : ['UPPERCASE', 'SCREAMING_SNAKE_CASE']
  }
  return [style]
}

/** Whether a name is written in `style` or is a single word that fits it. */
export function fitsCase(name: string, style: CaseStyle): boolean {
  return compatibleStyles(name).includes(style)
}

/** Whether the name's shape is ambiguous: it fits several styles and is no evidence for any. */
export function isAmbiguousCase(name: string): boolean {
  return compatibleStyles(name).length > 1
}

/** The words of a name, lowercased, split at `_`, `-` and case changes (`parseHTTPUrl2` → parse, http, url2). */
export function splitWords(name: string): string[] {
  return core(name)
    .body.replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replaceAll(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_\-$]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase())
}

const capitalize = (word: string) => (word[0]?.toUpperCase() ?? '') + word.slice(1)

/**
 * Rewrites a name into `style`, keeping leading and trailing `_`/`$`. `mixed` returns the name
 * unchanged.
 */
export function toCase(name: string, style: CaseStyle): string {
  const { prefix, suffix } = core(name)
  const words = splitWords(name)
  if (!words.length || style === 'mixed') return name
  let body: string
  switch (style) {
    case 'camelCase':
      body = (words[0] ?? '') + words.slice(1).map(capitalize).join('')
      break
    case 'PascalCase':
      body = words.map(capitalize).join('')
      break
    case 'SCREAMING_SNAKE_CASE':
      body = words.join('_').toUpperCase()
      break
    case 'snake_case':
      body = words.join('_')
      break
    case 'kebab-case':
      body = words.join('-')
      break
    case 'flatcase':
      body = words.join('')
      break
    case 'UPPERCASE':
      body = words.join('').toUpperCase()
      break
  }
  return prefix + body + suffix
}
