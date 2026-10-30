import { offsetOf } from '@holtkeeper/changes'
import type { Position } from '@holtkeeper/changes'

import {
  type ReplaceEdit,
  isBlank,
  lineStartOf,
  nextLineStart,
  removal,
  skipSpace,
} from './text.ts'

/** An export knip reported unused: its name and the 1-based position of that name. */
export interface ExportTarget {
  name: string
  at: Position
}

const declaration =
  /\bexport(\s+)(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:(?:const\s+enum|class|interface|type|enum|namespace|module)\s+|function\s*\*?\s*)$/

const variableStatement = /\bexport(\s+)(?:declare\s+)?(?:const|let|var|using)\s+/g

interface Declarator {
  name: string
  offset: number
}

const closers: Record<string, string> = { '(': ')', '[': ']', '{': '}' }

/**
 * Declarator names of the variable statement whose first declarator starts at `from`, or
 * `undefined` when a declarator is a destructuring pattern. Commas inside brackets, strings and
 * type arguments (a comma not followed by `name =`/`name:`) do not split declarators.
 */
function declarators(text: string, from: number): Declarator[] | undefined {
  const found: Declarator[] = []
  const take = (at: number) => {
    const start = skipSpace(text, at)
    const match = /^([A-Za-z_$][\w$]*)\s*(?=[:=,;\n]|$)/.exec(text.slice(start, start + 200))
    if (match?.[1]) found.push({ name: match[1], offset: start })
    return match !== null || /^[[{]/.test(text.slice(start, start + 1))
  }
  if (!take(from) || found.length === 0) return undefined
  const stack: string[] = []
  for (let index = from; index < text.length; index++) {
    const char = text[index] ?? ''
    if (char === '"' || char === "'" || char === '`') {
      for (index++; index < text.length && text[index] !== char; index++)
        if (text[index] === '\\') index++
    } else if (char === '/' && text[index + 1] === '/') {
      index = nextLineStart(text, index) - 2
    } else if (closers[char]) stack.push(closers[char])
    else if (char === stack.at(-1)) stack.pop()
    else if (stack.length > 0) continue
    else if (char === ';') break
    else if (char === '\n') {
      const next = text[skipSpace(text, index)]
      const last = text.slice(from, index).trimEnd().at(-1)
      if (next !== ',' && last !== ',' && last !== '=') break
    } else if (char === ',') {
      const before = found.length
      if (!take(index + 1)) continue
      if (found.length === before) return undefined
    }
  }
  return found
}

/** How far back from a name the `export` keyword or `{` of its statement is looked for. */
const LOOKBEHIND = 400

interface ExportList {
  /** Offset of `export`. */
  start: number
  open: number
  close: number
  /** Specifiers with their trimmed text bounds. */
  items: { start: number; end: number }[]
}

function exportList(text: string, offset: number): ExportList | undefined {
  const from = Math.max(0, offset - LOOKBEHIND)
  const before = text.slice(from, offset)
  const open = from + before.lastIndexOf('{')
  if (open < from || /[{};]/.test(text.slice(open + 1, offset))) return undefined
  const keyword = /\bexport\s*(?:type\s*)?$/.exec(text.slice(Math.max(0, open - 40), open))
  if (!keyword) return undefined
  const close = text.indexOf('}', offset)
  if (close === -1 || /[{;]/.test(text.slice(offset, close))) return undefined

  const items: ExportList['items'] = []
  let segment = open + 1
  for (let index = open + 1; index <= close; index++) {
    if (index !== close && text[index] !== ',') continue
    const raw = text.slice(segment, index)
    const lead = raw.length - raw.trimStart().length
    const trimmed = raw.trim()
    if (trimmed) items.push({ start: segment + lead, end: segment + lead + trimmed.length })
    segment = index + 1
  }
  return { start: Math.max(0, open - 40) + keyword.index, open, close, items }
}

/** Offsets removing the whole statement of `list`, with its line when it stands alone. */
function statementBounds(text: string, list: ExportList): [number, number] {
  let end = list.close + 1
  const from = /^\s*from\s*(['"])[^'"\n]*\1/.exec(text.slice(end))
  if (from) end += from[0].length
  end += /^[ \t]*;?/.exec(text.slice(end))?.[0].length ?? 0
  const lineStart = lineStartOf(text, list.start)
  const lineEnd = nextLineStart(text, end)
  if (isBlank(text.slice(lineStart, list.start)) && /^[ \t]*\r?\n?$/.test(text.slice(end, lineEnd)))
    return [lineStart, lineEnd]
  return [list.start, skipSpace(text, end) === text.length ? text.length : end]
}

/**
 * Edits that stop exporting `targets` from one file: the `export ` keyword of a declaration
 * (`export const x` → `const x`), or the specifier from an `export { a, b }` list — the whole
 * statement when every specifier goes. The edits never overlap. Default exports and names whose
 * statement is not recognized are left out of `removed`, and so is a variable statement with several declarators unless all of
 * them are unused.
 */
export function removeExportEdits(
  text: string,
  file: string,
  targets: readonly ExportTarget[],
): { edits: ReplaceEdit[]; removed: ExportTarget[] } {
  const removed: ExportTarget[] = []
  const keywords = new Map<number, number>()
  const lists = new Map<number, { list: ExportList; items: Set<number> }>()
  const offsets = new Map<number, ExportTarget>()
  for (const target of targets) {
    const offset = offsetOf(text, target.at)
    if (offset !== undefined && text.startsWith(target.name, offset)) offsets.set(offset, target)
  }

  for (const match of text.matchAll(variableStatement)) {
    const names = declarators(text, match.index + match[0].length)
    const unused = names?.map((entry) => offsets.get(entry.offset))
    for (const entry of names ?? []) offsets.delete(entry.offset)
    if (!unused?.every((target) => target !== undefined)) continue
    keywords.set(match.index, 'export'.length + (match[1]?.length ?? 0))
    removed.push(...unused)
  }

  for (const [offset, target] of offsets) {
    if (target.name === 'default') continue
    const from = Math.max(0, offset - LOOKBEHIND)
    const match = declaration.exec(text.slice(from, offset))
    if (match) {
      keywords.set(from + match.index, 'export'.length + (match[1]?.length ?? 0))
      removed.push(target)
      continue
    }
    const list = exportList(text, offset)
    const item = list?.items.findIndex((entry) => entry.start <= offset && offset < entry.end) ?? -1
    if (!list || item === -1) continue
    const entry = lists.get(list.open) ?? { list, items: new Set<number>() }
    entry.items.add(item)
    removed.push(target)
    lists.set(list.open, entry)
  }

  const spans: [number, number][] = [...keywords].map(([start, length]) => [start, start + length])
  for (const { list, items: gone } of lists.values()) {
    const { items } = list
    if (gone.size === items.length) {
      spans.push(statementBounds(text, list))
      continue
    }
    for (const index of gone) {
      const keptAfter = items.some((_, later) => later > index && !gone.has(later))
      const item = items[index]
      const neighbor = keptAfter ? items[index + 1] : items[index - 1]
      if (!item || !neighbor) continue
      spans.push(keptAfter ? [item.start, neighbor.start] : [neighbor.end, item.end])
    }
  }

  spans.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const span of spans) {
    const last = merged.at(-1)
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1])
    else merged.push([...span])
  }
  return { edits: merged.map(([start, end]) => removal(text, file, start, end)), removed }
}
