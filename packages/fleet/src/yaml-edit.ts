import type { Difference, KeyPath } from './subset.ts'
import type { Splice } from './text.ts'

interface Line {
  start: number
  /** Offset of the line end, before `\n`. */
  end: number
  indent: number
  content: string
}

const plain = /^[A-Za-z_./@~][\w ./@~+:-]*$/
const reserved = /^(true|false|yes|no|on|off|null|~)$/i

/** A YAML scalar: plain when that reads back as the same string, JSON-quoted otherwise. */
export function yamlScalar(value: unknown): string {
  if (typeof value === 'string')
    return plain.test(value) && !reserved.test(value) && !/(: |:$| $)/.test(value)
      ? value
      : JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return value === null || value === undefined ? 'null' : JSON.stringify(value)
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Block-style YAML lines for `value` at `indent` spaces. */
export function emitYaml(value: unknown, indent: number): string[] {
  const pad = ' '.repeat(indent)
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (isObject(item) || Array.isArray(item)) {
        const [first = '', ...rest] = emitYaml(item, indent + 2)
        return [`${pad}- ${first.trimStart()}`, ...rest]
      }
      return [`${pad}- ${yamlScalar(item)}`]
    })
  }
  if (isObject(value)) {
    return Object.entries(value).flatMap(([key, child]) => {
      const name = yamlScalar(key)
      if ((isObject(child) && Object.keys(child).length) || (Array.isArray(child) && child.length))
        return [`${pad}${name}:`, ...emitYaml(child, indent + 2)]
      if (isObject(child)) return [`${pad}${name}: {}`]
      if (Array.isArray(child)) return [`${pad}${name}: []`]
      return [`${pad}${name}: ${yamlScalar(child)}`]
    })
  }
  return [`${pad}${yamlScalar(value)}`]
}

function linesOf(text: string): Line[] {
  const lines: Line[] = []
  let start = 0
  for (const raw of text.split('\n')) {
    const content = raw.trim()
    if (content && !content.startsWith('#') && content !== '---')
      lines.push({
        start,
        end: start + raw.replace(/\r$/, '').length,
        indent: raw.length - raw.trimStart().length,
        content,
      })
    start += raw.length + 1
  }
  return lines
}

const keyPattern = (key: string) => {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^(?:${escaped}|"${escaped}"|'${escaped}')\\s*:(?:\\s|$)`)
}

interface Block {
  /** Indices into the content lines, `[from, to)`. */
  from: number
  to: number
}

interface KeyLine {
  line: Line
  /** Offset right after the key's colon. */
  valueStart: number
  /** Lines of the nested value, possibly empty. */
  child: Block
}

/** Children of the line at `index`: following lines indented deeper, or `- ` items at the same indent. */
function childBlock(lines: Line[], index: number, to: number): Block {
  const owner = lines[index]!
  let end = index + 1
  while (end < to) {
    const line = lines[end]!
    if (
      line.indent > owner.indent ||
      (line.indent === owner.indent && line.content.startsWith('-'))
    )
      end++
    else break
  }
  return { from: index + 1, to: end }
}

function findKey(lines: Line[], block: Block, key: string): KeyLine | undefined {
  const indent = lines[block.from]?.indent
  const pattern = keyPattern(key)
  for (let index = block.from; index < block.to; index++) {
    const line = lines[index]!
    if (line.indent !== indent || !pattern.test(line.content)) continue
    const colon = line.start + line.indent + (pattern.exec(line.content)?.[0].trimEnd().length ?? 0)
    return { line, valueStart: colon, child: childBlock(lines, index, block.to) }
  }
  return undefined
}

function locate(lines: Line[], path: KeyPath): KeyLine | undefined {
  let block: Block = { from: 0, to: lines.length }
  let found: KeyLine | undefined
  for (const key of path) {
    found = findKey(lines, block, key)
    if (!found) return undefined
    block = found.child
  }
  return found
}

const inlineValue = (text: string, key: KeyLine) =>
  text
    .slice(key.valueStart, key.line.end)
    .replace(/\s+#.*$/, '')
    .trim()

/**
 * Minimal splices that make a block-style YAML `text` contain the template its `differences`
 * came from, or `undefined` when one of them needs an edit this module does not attempt (flow
 * collections, block scalars, anchors).
 */
export function yamlSplices(text: string, differences: Difference[]): Splice[] | undefined {
  const lines = linesOf(text)
  const splices: Splice[] = []
  for (const difference of differences) {
    if (difference.kind === 'mismatch') {
      const key = locate(lines, difference.path)
      if (!key) return undefined
      const inline = inlineValue(text, key)
      if (/^[|>&*!]/.test(inline)) return undefined
      const last = lines[key.child.to - 1]
      const end =
        key.child.to > key.child.from && last
          ? last.end
          : key.valueStart + text.slice(key.valueStart, key.line.end).replace(/\s+#.*$/, '').length
      const expected = difference.expected
      const nested = isObject(expected)
        ? Object.keys(expected).length > 0
        : Array.isArray(expected) && expected.length > 0
      const newText = nested
        ? `\n${emitYaml(expected, key.line.indent + 2).join('\n')}`
        : ` ${emitYaml(expected, 0)[0]?.trim() ?? ''}`
      splices.push({ start: key.valueStart, end, newText })
      continue
    }
    const containerPath =
      difference.kind === 'missing' ? difference.path.slice(0, -1) : difference.path
    const owner = containerPath.length ? locate(lines, containerPath) : undefined
    if (containerPath.length && (!owner || inlineValue(text, owner) !== '')) return undefined
    const block = owner ? owner.child : { from: 0, to: lines.length }
    const first = lines[block.from]
    const last = lines[block.to - 1]
    const indent = first ? first.indent : owner ? owner.line.indent + 2 : 0
    const value =
      difference.kind === 'missing'
        ? { [difference.path.at(-1)!]: difference.expected }
        : [difference.expected]
    if (difference.kind === 'missing-item' && first && !first.content.startsWith('-'))
      return undefined
    const at = last ? last.end : owner ? owner.line.end : text.replace(/\s+$/, '').length
    const prefix = at === 0 ? '' : '\n'
    splices.push({ start: at, end: at, newText: prefix + emitYaml(value, indent).join('\n') })
  }
  return splices
}
