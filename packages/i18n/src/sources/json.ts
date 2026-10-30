import { locateCatalog } from '../locate.ts'
import type { CatalogEntry, CatalogInsert, CatalogSource } from '../types.ts'
import { type JsonMember, type JsonNode, parseJsonTree } from './json-tree.ts'

type ObjectNode = Extract<JsonNode, { type: 'object' }>

const MESSAGE_PROPS = ['defaultMessage', 'message'] as const

type LeafShape = { kind: 'string' } | { kind: 'message'; prop: string } | { kind: 'ast' }

function astText(node: Extract<JsonNode, { type: 'array' }>): string | undefined {
  let text = ''
  for (const item of node.items) {
    if (item.type !== 'object') return undefined
    const type = item.members.find((m) => m.key === 'type')?.value
    const value = item.members.find((m) => m.key === 'value')?.value
    if (type?.type !== 'literal' || typeof type.value !== 'number') return undefined
    const name = value?.type === 'string' ? value.value : ''
    text += type.value === 0 ? name : type.value === 7 ? '#' : `{${name}}`
  }
  return text
}

/** Leaf text and shape of a JSON value, or `undefined` for containers and non-text values. */
function leafOf(node: JsonNode): { text: string; shape: LeafShape } | undefined {
  if (node.type === 'string') return { text: node.value, shape: { kind: 'string' } }
  if (node.type === 'array') {
    const text = node.items.length ? astText(node) : undefined
    return text === undefined ? undefined : { text, shape: { kind: 'ast' } }
  }
  if (node.type !== 'object' || !node.members.every((m) => m.value.type === 'string'))
    return undefined
  for (const prop of MESSAGE_PROPS) {
    const member = node.members.find((m) => m.key === prop)
    if (member?.value.type === 'string')
      return { text: member.value.value, shape: { kind: 'message', prop } }
  }
  return undefined
}

const isContainer = (node: JsonNode): node is ObjectNode =>
  node.type === 'object' && leafOf(node) === undefined

function lineIndex(text: string) {
  const starts = [0]
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1)
  return (offset: number) => {
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if (starts[mid]! <= offset) low = mid
      else high = mid - 1
    }
    return low + 1
  }
}

function rootObject(text: string): ObjectNode {
  const root = parseJsonTree(text)
  if (root.type !== 'object') throw new SyntaxError('a catalog must be a JSON object')
  return root
}

/** Leaf entries of a JSON catalog, nested keys joined with `.`. */
export function jsonEntries(text: string): CatalogEntry[] {
  const root = rootObject(text)
  const lineOf = lineIndex(text)
  const entries: CatalogEntry[] = []
  const walk = (node: ObjectNode, prefix: string) => {
    for (const member of node.members) {
      const key = prefix ? `${prefix}.${member.key}` : member.key
      const leaf = leafOf(member.value)
      if (leaf) entries.push({ key, value: leaf.text, line: lineOf(member.keyStart) })
      else if (member.value.type === 'object') walk(member.value, key)
    }
  }
  walk(root, '')
  return entries
}

/** Member of `node` that `rest` resolves through: the longest member key that prefixes it. */
function memberFor(node: ObjectNode, rest: string): JsonMember | undefined {
  let best: JsonMember | undefined
  for (const member of node.members) {
    if (rest === member.key || rest.startsWith(`${member.key}.`)) {
      if (!best || member.key.length > best.key.length) best = member
    }
  }
  return best
}

interface Located {
  container: ObjectNode
  /** Full key of `container`, `''` for the root. */
  prefix: string
  /** Remaining key below `container`. */
  rest: string
  /** Member chain from the root to `container`. */
  path: { container: ObjectNode; member: JsonMember }[]
}

function locate(root: ObjectNode, key: string): Located {
  let container = root
  let prefix = ''
  let rest = key
  const path: Located['path'] = []
  for (;;) {
    const member = memberFor(container, rest)
    if (!member || member.key === rest || !isContainer(member.value)) break
    path.push({ container, member })
    prefix = prefix ? `${prefix}.${member.key}` : member.key
    rest = rest.slice(member.key.length + 1)
    container = member.value
  }
  return { container, prefix, rest, path }
}

const lineStartOf = (text: string, offset: number) => text.lastIndexOf('\n', offset - 1) + 1

const indentAt = (text: string, offset: number) => {
  const start = lineStartOf(text, offset)
  return /^[ \t]*/.exec(text.slice(start, offset))?.[0] ?? ''
}

interface Style {
  newline: string
  unit: string
  colon: string
  shape: LeafShape
}

function styleOf(text: string, root: ObjectNode): Style {
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const first = root.members[0]
  const lead = first ? text.slice(root.start + 1, first.keyStart) : `${newline}  `
  const unit = lead.includes('\n') ? lead.slice(lead.lastIndexOf('\n') + 1) : ''
  const colon = first ? text.slice(first.keyEnd, first.value.start) : ': '
  let shape: LeafShape = { kind: 'string' }
  const find = (node: ObjectNode): boolean => {
    for (const member of node.members) {
      const leaf = leafOf(member.value)
      if (leaf) {
        shape = leaf.shape
        return true
      }
      if (member.value.type === 'object' && find(member.value)) return true
    }
    return false
  }
  find(root)
  return { newline, unit: unit || (lead.includes('\n') ? '  ' : ''), colon, shape }
}

function renderLeaf(value: string, style: Style, indent: string): string {
  const json = JSON.stringify(value)
  if (style.shape.kind === 'string') return json
  if (style.shape.kind === 'ast') return `[{"type":0,"value":${json}}]`
  const member = `${JSON.stringify(style.shape.prop)}${style.colon}${json}`
  return style.unit
    ? `{${style.newline}${indent}${style.unit}${member}${style.newline}${indent}}`
    : `{${member}}`
}

/** `"a": { "b": "value" }` for the segments below a container, in the file's style. */
function renderMember(segments: string[], value: string, style: Style, indent: string): string {
  const [head, ...tail] = segments
  const key = JSON.stringify(head)
  if (tail.length === 0) return `${key}${style.colon}${renderLeaf(value, style, indent)}`
  const inner = indent + style.unit
  const child = renderMember(tail, value, style, inner)
  return style.unit
    ? `${key}${style.colon}{${style.newline}${inner}${child}${style.newline}${indent}}`
    : `${key}${style.colon}{${child}}`
}

function insertOne(
  text: string,
  insert: CatalogInsert,
  order: readonly string[],
  flat: boolean,
): string {
  const root = rootObject(text)
  const style = styleOf(text, root)
  const { container, prefix, rest } = locate(root, insert.key)
  if (container.members.some((m) => m.key === rest)) return text
  const segments = flat && container === root ? [rest] : rest.split('.')
  const members = container.members

  if (members.length === 0) {
    const outer = indentAt(text, container.start)
    const inner = outer + style.unit
    const member = renderMember(segments, insert.value, style, inner)
    const body = style.unit ? `${style.newline}${inner}${member}${style.newline}${outer}` : member
    return text.slice(0, container.start + 1) + body + text.slice(container.end - 1)
  }

  const first = members[0]!
  const lead = text.slice(container.start + 1, first.keyStart)
  const second = members[1]
  const between = second
    ? text.slice(text.indexOf(',', first.value.end) + 1, second.keyStart)
    : lead
  const indent = lead.includes('\n') ? lead.slice(lead.lastIndexOf('\n') + 1) : ''
  const member = renderMember(segments, insert.value, style, indent)

  const relative = (key: string) => {
    if (!prefix) return key
    return key.startsWith(`${prefix}.`) ? key.slice(prefix.length + 1) : undefined
  }
  const position = order.indexOf(insert.key)
  const siblingAt = (key: string | undefined) => {
    const below = key === undefined ? undefined : relative(key)
    return below === undefined ? undefined : memberFor(container, below)
  }
  if (position !== -1) {
    for (let i = position - 1; i >= 0; i--) {
      const sibling = siblingAt(order[i])
      if (sibling) {
        const at = sibling.value.end
        return `${text.slice(0, at)},${between}${member}${text.slice(at)}`
      }
    }
    for (let i = position + 1; i < order.length; i++) {
      const sibling = siblingAt(order[i])
      if (sibling) {
        const at = sibling.keyStart
        return `${text.slice(0, at)}${member},${between}${text.slice(at)}`
      }
    }
  }
  const at = members.at(-1)!.value.end
  return `${text.slice(0, at)},${between}${member}${text.slice(at)}`
}

function removeOne(text: string, key: string): string {
  const root = rootObject(text)
  const { container, rest, path } = locate(root, key)
  const index = container.members.findIndex((m) => m.key === rest)
  if (index === -1) return text
  const members = container.members
  let result: string
  if (members.length === 1) {
    if (path.length > 0) {
      const parent = path.map((step) => step.member.key).join('.')
      return removeOne(text, parent)
    }
    result = `${text.slice(0, container.start + 1)}${text.slice(container.end - 1)}`
  } else if (index < members.length - 1) {
    result = text.slice(0, members[index]!.keyStart) + text.slice(members[index + 1]!.keyStart)
  } else {
    result = text.slice(0, members[index - 1]!.value.end) + text.slice(members[index]!.value.end)
  }
  return result
}

const hasDottedKeys = (node: ObjectNode): boolean =>
  node.members.some(
    (m) => m.key.includes('.') || (m.value.type === 'object' && hasDottedKeys(m.value)),
  )

/** Inserts keys into JSON catalog text, keeping its indentation, quoting and key order. */
export function insertJson(
  text: string,
  inserts: readonly CatalogInsert[],
  order: readonly string[],
): string {
  const flat = hasDottedKeys(rootObject(text))
  let result = text
  for (const insert of inserts) result = insertOne(result, insert, order, flat)
  return result
}

/** Removes keys from JSON catalog text; objects left empty are removed too. */
export function removeJson(text: string, keys: readonly string[]): string {
  let result = text
  for (const key of keys) result = removeOne(result, key)
  return result
}

const JSON_FILE = /\.json$/i
const NOT_CATALOGS =
  /(^|\/)(package|tsconfig[^/]*|jsconfig|composer|bower|lerna|turbo|nx|deno)\.json$/i

/**
 * i18next / react-i18next / vue-i18n / formatjs JSON catalogs: `locales/<lng>/<ns>.json`,
 * `<lng>.json`, nested or flat keys, formatjs `{ id: { defaultMessage } }` and compiled ASTs.
 */
export const jsonSource = (): CatalogSource => ({
  format: 'json',
  matches: (file) => JSON_FILE.test(file) && !NOT_CATALOGS.test(file),
  locate: locateCatalog,
  parse: (text) => ({ entries: jsonEntries(text) }),
  insert: insertJson,
  remove: removeJson,
})
