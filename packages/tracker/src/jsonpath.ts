/** One step of a parsed path: a property, an index, or a wildcard over members or items. */
export type PathToken =
  | { kind: 'prop'; name: string }
  | { kind: 'index'; index: number }
  | { kind: 'wildcard' }

/** A value a path selected and where it sits. */
export interface PathMatch {
  value: unknown
  path: (string | number)[]
  /** Set when the last step was a wildcard over an object's members. */
  member?: string
}

/**
 * Parses the JSONPath subset trackers use: `$`, `.name`, `['name']`, `.*`, `[*]` and `[0]`.
 * Throws on anything else.
 */
export function parsePath(expression: string): PathToken[] {
  const text = expression.trim()
  if (!text.startsWith('$')) throw new Error(`path ${expression} must start with $`)
  const tokens: PathToken[] = []
  let index = 1
  while (index < text.length) {
    const rest = text.slice(index)
    const dot = /^\.(\*|[A-Za-z0-9_$-]+)/.exec(rest)
    if (dot) {
      tokens.push(dot[1] === '*' ? { kind: 'wildcard' } : { kind: 'prop', name: dot[1]! })
      index += dot[0].length
      continue
    }
    const bracket = /^\[\s*(\*|\d+|'([^']*)'|"([^"]*)")\s*\]/.exec(rest)
    if (bracket) {
      const inner = bracket[1]!
      if (inner === '*') tokens.push({ kind: 'wildcard' })
      else if (/^\d+$/.test(inner)) tokens.push({ kind: 'index', index: Number(inner) })
      else tokens.push({ kind: 'prop', name: bracket[2] ?? bracket[3] ?? '' })
      index += bracket[0].length
      continue
    }
    throw new Error(`unsupported path syntax at "${rest}" in ${expression}`)
  }
  return tokens
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Every value `expression` selects in `root`, in document order. */
export function selectPath(root: unknown, expression: string | PathToken[]): PathMatch[] {
  const tokens = typeof expression === 'string' ? parsePath(expression) : expression
  let matches: PathMatch[] = [{ value: root, path: [] }]
  for (const token of tokens) {
    const next: PathMatch[] = []
    for (const match of matches) {
      const { value, path } = match
      if (token.kind === 'prop') {
        if (isObject(value) && Object.hasOwn(value, token.name))
          next.push({ value: value[token.name], path: [...path, token.name] })
      } else if (token.kind === 'index') {
        if (Array.isArray(value) && token.index < value.length)
          next.push({ value: value[token.index], path: [...path, token.index] })
      } else if (Array.isArray(value)) {
        value.forEach((item, position) => next.push({ value: item, path: [...path, position] }))
      } else if (isObject(value)) {
        for (const [name, item] of Object.entries(value))
          next.push({ value: item, path: [...path, name], member: name })
      }
    }
    matches = next
  }
  return matches
}

/** A scalar as text; objects and arrays as JSON; `undefined` and `null` as nothing. */
export function scalarText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    return String(value)
  if (value instanceof Date) return value.toISOString()
  return JSON.stringify(value)
}
