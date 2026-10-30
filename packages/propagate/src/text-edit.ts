/** Where a JSON value sits in its text; `end` is exclusive. */
type JsonNode =
  | { type: 'object'; start: number; end: number; entries: { key: string; value: JsonNode }[] }
  | { type: 'array'; start: number; end: number; items: JsonNode[] }
  | { type: 'scalar'; start: number; end: number }

/** Parses JSON (comments and trailing commas allowed) into value positions; throws on invalid input. */
function parseJsonTree(text: string): JsonNode {
  let at = 0
  const fail = (what: string): never => {
    throw new Error(`invalid JSON at offset ${at}: ${what}`)
  }
  const skip = () => {
    for (;;) {
      while (at < text.length && /\s/.test(text[at]!)) at++
      if (text.startsWith('//', at)) {
        const end = text.indexOf('\n', at)
        at = end === -1 ? text.length : end
      } else if (text.startsWith('/*', at)) {
        const end = text.indexOf('*/', at + 2)
        if (end === -1) fail('unterminated comment')
        at = end + 2
      } else return
    }
  }
  const string = () => {
    const start = at++
    while (at < text.length && text[at] !== '"') at += text[at] === '\\' ? 2 : 1
    if (at >= text.length) fail('unterminated string')
    at++
    return String(JSON.parse(text.slice(start, at)))
  }
  const value = (): JsonNode => {
    skip()
    const start = at
    const char = text[at]
    if (char === '{' || char === '[') {
      const close = char === '{' ? '}' : ']'
      at++
      const entries: { key: string; value: JsonNode }[] = []
      const items: JsonNode[] = []
      for (;;) {
        skip()
        if (text[at] === close) break
        if (char === '{') {
          if (text[at] !== '"') fail('expected a key')
          const key = string()
          skip()
          if (text[at++] !== ':') fail('expected ":"')
          entries.push({ key, value: value() })
        } else items.push(value())
        skip()
        if (text[at] === ',') at++
        else if (text[at] !== close) fail(`expected "," or "${close}"`)
      }
      at++
      return char === '{'
        ? { type: 'object', start, end: at, entries }
        : { type: 'array', start, end: at, items }
    }
    if (char === '"') {
      string()
      return { type: 'scalar', start, end: at }
    }
    while (at < text.length && /[\w.+-]/.test(text[at]!)) at++
    if (at === start) fail('unexpected character')
    return { type: 'scalar', start, end: at }
  }
  const root = value()
  skip()
  if (at < text.length) fail('trailing content')
  return root
}

/**
 * Replaces the string at `path` in JSON `text` with `value`, keeping every other byte. Returns
 * `undefined` when the path does not lead to a string.
 */
export function setJsonString(text: string, path: string[], value: string): string | undefined {
  let node: JsonNode | undefined = parseJsonTree(text)
  for (const key of path) {
    node = node?.type === 'object' ? node.entries.findLast((e) => e.key === key)?.value : undefined
  }
  if (!node || node.type !== 'scalar' || text[node.start] !== '"') return undefined
  return text.slice(0, node.start) + JSON.stringify(value) + text.slice(node.end)
}

interface YamlLine {
  start: number
  end: number
  indent: number
  content: string
}

function yamlLines(text: string): YamlLine[] {
  const lines: YamlLine[] = []
  let start = 0
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    const content = line.trim()
    if (content && !content.startsWith('#'))
      lines.push({
        start,
        end: start + line.length,
        indent: line.length - line.trimStart().length,
        content,
      })
    start += raw.length + 1
  }
  return lines
}

const keyOf = (content: string) => {
  const match = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^:#'"][^:#]*?)\s*:(?:\s|$)/.exec(content)
  if (!match) return undefined
  const raw = match[1]!
  const key = raw.startsWith('"')
    ? String(JSON.parse(raw))
    : raw.startsWith("'")
      ? raw.slice(1, -1).replaceAll("''", "'")
      : raw
  return { key, length: match[0].length }
}

/**
 * Replaces the scalar at `path` in block-style YAML `text` with `value`, keeping the quote style
 * and any trailing comment. Returns `undefined` when the path does not lead to an inline scalar.
 */
export function setYamlScalar(text: string, path: string[], value: string): string | undefined {
  const lines = yamlLines(text)
  let from = 0
  let to = lines.length
  let found: YamlLine | undefined
  let keyLength = 0
  for (const key of path) {
    const indent = lines[from]?.indent
    found = undefined
    for (let i = from; i < to; i++) {
      const line = lines[i]!
      if (line.indent !== indent) continue
      const parsed = keyOf(line.content)
      if (parsed?.key !== key) continue
      found = line
      keyLength = parsed.length
      let end = i + 1
      while (end < to && lines[end]!.indent > line.indent) end++
      from = i + 1
      to = end
      break
    }
    if (!found) return undefined
  }
  if (!found) return undefined
  const valueStart = found.start + found.indent + keyLength
  const rest = text.slice(valueStart, found.end)
  const match = /^(\s*)("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#][^#]*?)(\s+#.*)?\s*$/.exec(rest)
  if (!match || /^[|>&*!{[]/.test(match[2]!)) return undefined
  const old = match[2]!
  const quoted = old.startsWith('"')
    ? JSON.stringify(value)
    : old.startsWith("'") || /^[&*!|>%@`{[]|: | #/.test(value)
      ? `'${value.replaceAll("'", "''")}'`
      : value
  const start = valueStart + match[1]!.length
  return text.slice(0, start) + quoted + text.slice(start + old.length)
}

/** Strings of a YAML value at `path` read with Bun's parser; `{}` when absent. */
export function yamlRecord(text: string, path: string[]): Record<string, string> {
  let node: unknown = Bun.YAML.parse(text)
  for (const key of path)
    node =
      typeof node === 'object' && node !== null && !Array.isArray(node)
        ? Reflect.get(node, key)
        : undefined
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return {}
  return Object.fromEntries(
    Object.entries(node).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}
