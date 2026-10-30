import type { Difference, KeyPath } from './subset.ts'
import { indentAt, indentUnit, type Splice } from './text.ts'

/** Where a JSON value sits in its text; `end` is exclusive. */
export type JsonNode =
  | {
      type: 'object'
      start: number
      end: number
      entries: { key: string; keyStart: number; value: JsonNode }[]
    }
  | { type: 'array'; start: number; end: number; items: JsonNode[] }
  | { type: 'scalar'; start: number; end: number }

/** Parses JSON with comments and trailing commas into value positions; throws on invalid input. */
export function parseJsonTree(text: string): JsonNode {
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
    const parsed: unknown = JSON.parse(text.slice(start, at))
    return String(parsed)
  }
  const value = (): JsonNode => {
    skip()
    const start = at
    const char = text[at]
    if (char === '{') {
      at++
      const entries: { key: string; keyStart: number; value: JsonNode }[] = []
      for (;;) {
        skip()
        if (text[at] === '}') break
        if (text[at] !== '"') fail('expected a key')
        const keyStart = at
        const key = string()
        skip()
        if (text[at++] !== ':') fail('expected ":"')
        entries.push({ key, keyStart, value: value() })
        skip()
        if (text[at] === ',') at++
        else if (text[at] !== '}') fail('expected "," or "}"')
      }
      at++
      return { type: 'object', start, end: at, entries }
    }
    if (char === '[') {
      at++
      const items: JsonNode[] = []
      for (;;) {
        skip()
        if (text[at] === ']') break
        items.push(value())
        skip()
        if (text[at] === ',') at++
        else if (text[at] !== ']') fail('expected "," or "]"')
      }
      at++
      return { type: 'array', start, end: at, items }
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

function nodeAt(root: JsonNode, path: KeyPath): JsonNode | undefined {
  let node: JsonNode | undefined = root
  for (const key of path) {
    if (node?.type !== 'object') return undefined
    node = node.entries.findLast((entry) => entry.key === key)?.value
  }
  return node
}

const serialize = (value: unknown, indent: string, unit: string) =>
  JSON.stringify(value, null, unit).replaceAll('\n', `\n${indent}`)

/** Offset right after `offset` and an optional trailing comma (skipping whitespace and comments). */
function afterComma(text: string, offset: number): { offset: number; comma: boolean } {
  const rest = /^(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*,/.exec(text.slice(offset))
  return rest ? { offset: offset + rest[0].length, comma: true } : { offset, comma: false }
}

const sameLine = (text: string, from: number, to: number) => !text.slice(from, to).includes('\n')

function insertInto(
  text: string,
  container: Extract<JsonNode, { type: 'object' | 'array' }>,
  parts: string[],
  values: unknown[],
  unit: string,
): Splice {
  const children =
    container.type === 'object'
      ? container.entries.map((e) => ({ start: e.keyStart, end: e.value.end }))
      : container.items
  const last = children.at(-1)
  const closing = container.end - 1
  const parentIndent = indentAt(text, container.start)
  if (!last) {
    const indent = parentIndent + unit
    const body = parts.map((part, i) => part + serialize(values[i], indent, unit))
    return {
      start: container.start + 1,
      end: closing,
      newText: `\n${indent}${body.join(`,\n${indent}`)}\n${parentIndent}`,
    }
  }
  const { offset, comma } = afterComma(text, last.end)
  if (sameLine(text, container.start, last.start)) {
    const body = parts.map((part, i) => part + JSON.stringify(values[i]))
    return comma
      ? { start: offset, end: offset, newText: ` ${body.join(', ')},` }
      : { start: offset, end: offset, newText: `, ${body.join(', ')}` }
  }
  const indent = indentAt(text, last.start)
  const body = parts.map((part, i) => part + serialize(values[i], indent, unit))
  return comma
    ? { start: offset, end: offset, newText: body.map((line) => `\n${indent}${line},`).join('') }
    : { start: offset, end: offset, newText: body.map((line) => `,\n${indent}${line}`).join('') }
}

/**
 * Minimal splices that make a JSON(C) `text` contain the template its `differences` came from:
 * changed values are replaced in place, missing keys and array items are appended to their
 * container in the file's own indentation. Comments and formatting elsewhere are kept.
 */
export function jsonSplices(text: string, differences: Difference[]): Splice[] {
  const root = parseJsonTree(text)
  const unit = indentUnit(text)
  const splices: Splice[] = []
  const inserts = new Map<JsonNode, { parts: string[]; values: unknown[] }>()

  for (const difference of differences) {
    if (difference.kind === 'mismatch') {
      const node = nodeAt(root, difference.path)
      if (!node) continue
      splices.push({
        start: node.start,
        end: node.end,
        newText: serialize(difference.expected, indentAt(text, node.start), unit),
      })
      continue
    }
    const containerPath =
      difference.kind === 'missing' ? difference.path.slice(0, -1) : difference.path
    const container = nodeAt(root, containerPath)
    if (!container || container.type === 'scalar') continue
    const pending = inserts.get(container) ?? { parts: [], values: [] }
    pending.parts.push(
      difference.kind === 'missing' ? `${JSON.stringify(difference.path.at(-1))}: ` : '',
    )
    pending.values.push(difference.expected)
    inserts.set(container, pending)
  }
  for (const [container, { parts, values }] of inserts) {
    if (container.type !== 'scalar') splices.push(insertInto(text, container, parts, values, unit))
  }
  return splices
}
