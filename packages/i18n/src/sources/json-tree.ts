/** A JSON value with the offsets it occupies in the source text (`end` is exclusive). */
export type JsonNode =
  | { type: 'object'; start: number; end: number; members: JsonMember[] }
  | { type: 'array'; start: number; end: number; items: JsonNode[] }
  | { type: 'string'; start: number; end: number; value: string }
  | { type: 'literal'; start: number; end: number; value: number | boolean | null }

export interface JsonMember {
  key: string
  keyStart: number
  keyEnd: number
  value: JsonNode
}

/** Parses JSON keeping offsets; throws on invalid JSON, like `JSON.parse`. */
export function parseJsonTree(text: string): JsonNode {
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0

  const fail = (what: string): never => {
    throw new SyntaxError(`invalid JSON at offset ${index}: ${what}`)
  }
  const space = () => {
    while (index < text.length && ' \t\n\r'.includes(text[index]!)) index++
  }
  const string = (): { value: string; start: number; end: number } => {
    const start = index
    index++
    while (index < text.length && text[index] !== '"') index += text[index] === '\\' ? 2 : 1
    if (index >= text.length) fail('unterminated string')
    index++
    const decoded: unknown = JSON.parse(text.slice(start, index))
    return { value: typeof decoded === 'string' ? decoded : '', start, end: index }
  }
  const value = (): JsonNode => {
    space()
    const start = index
    const char = text[index]
    if (char === '{') {
      index++
      const members: JsonMember[] = []
      space()
      if (text[index] === '}') {
        index++
        return { type: 'object', start, end: index, members }
      }
      for (;;) {
        space()
        if (text[index] !== '"') fail('expected a key')
        const key = string()
        space()
        if (text[index] !== ':') fail('expected ":"')
        index++
        members.push({ key: key.value, keyStart: key.start, keyEnd: key.end, value: value() })
        space()
        if (text[index] === ',') {
          index++
          continue
        }
        if (text[index] === '}') {
          index++
          return { type: 'object', start, end: index, members }
        }
        fail('expected "," or "}"')
      }
    }
    if (char === '[') {
      index++
      const items: JsonNode[] = []
      space()
      if (text[index] === ']') {
        index++
        return { type: 'array', start, end: index, items }
      }
      for (;;) {
        items.push(value())
        space()
        if (text[index] === ',') {
          index++
          continue
        }
        if (text[index] === ']') {
          index++
          return { type: 'array', start, end: index, items }
        }
        fail('expected "," or "]"')
      }
    }
    if (char === '"') return { type: 'string', ...string() }
    const literal = /^(?:-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|true|false|null)/.exec(text.slice(index))
    if (!literal) return fail('unexpected character')
    index += literal[0].length
    const parsed: unknown = JSON.parse(literal[0])
    const scalar = typeof parsed === 'number' || typeof parsed === 'boolean' ? parsed : null
    return { type: 'literal', start, end: index, value: scalar }
  }

  const root = value()
  space()
  if (index < text.length) fail('unexpected trailing text')
  return root
}
