import { offsetOf } from '@holtkeeper/changes'
import type { Position } from '@holtkeeper/changes'

import {
  type ReplaceEdit,
  isBlank,
  lineStartOf,
  nextLineStart,
  removal,
  skipSpace,
  skipSpaceBack,
} from './text.ts'

/** Dependency fields of `package.json` knip reports on. */
export type DependencyField =
  | 'dependencies'
  | 'devDependencies'
  | 'optionalDependencies'
  | 'peerDependencies'

/** Offset of the opening quote of `"name":` — at `at` when knip's position points there, else the only such key. */
function keyStart(text: string, name: string, at: Position | undefined): number | undefined {
  const quoted = JSON.stringify(name)
  if (at) {
    const offset = offsetOf(text, at)
    if (offset !== undefined && text.startsWith(quoted, offset - 1)) return offset - 1
    if (offset !== undefined && text.startsWith(quoted, offset)) return offset
  }
  const pattern = new RegExp(`${quoted.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`, 'g')
  const matches = [...text.matchAll(pattern)]
  return matches.length === 1 ? matches[0]?.index : undefined
}

/** Offset just past the JSON string starting at `start`, or `undefined` when there is none. */
function stringEnd(text: string, start: number): number | undefined {
  if (text[start] !== '"') return undefined
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === '\\') index++
    else if (text[index] === '"') return index + 1
    else if (text[index] === '\n') return undefined
  }
  return undefined
}

const without = (text: string, edit: ReplaceEdit) => {
  const start = offsetOf(text, edit.range.start) ?? 0
  const end = offsetOf(text, edit.range.end) ?? 0
  return text.slice(0, start) + text.slice(end)
}

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const listed = (manifest: unknown, field: DependencyField, name: string) => {
  if (typeof manifest !== 'object' || manifest === null) return false
  const deps: unknown = Reflect.get(manifest, field)
  return typeof deps === 'object' && deps !== null && Object.hasOwn(deps, name)
}

/**
 * The smallest edit removing dependency `name` from `field` of a `package.json` text, keeping it
 * valid JSON and its formatting: a whole line with its trailing comma, or — for the last entry —
 * the comma before it; the only entry leaves `{}`. `at` is knip's position of the name. The result
 * is checked by parsing; `undefined` when the entry cannot be located or removed cleanly.
 *
 * Entries other than the last never touch each other's text, so any selection of removals in one
 * object combines, except removing both of its last two entries at once.
 */
export function removeDependencyEdit(
  text: string,
  file: string,
  field: DependencyField,
  name: string,
  at?: Position,
): ReplaceEdit | undefined {
  const before = parse(text)
  if (!listed(before, field, name)) return undefined
  const key = keyStart(text, name, at)
  if (key === undefined) return undefined
  const keyEnd = stringEnd(text, key)
  if (keyEnd === undefined) return undefined
  const colon = skipSpace(text, keyEnd)
  if (text[colon] !== ':') return undefined
  const valueEnd = stringEnd(text, skipSpace(text, colon + 1))
  if (valueEnd === undefined) return undefined

  const next = skipSpace(text, valueEnd)
  const previous = skipSpaceBack(text, key)
  let edit: ReplaceEdit | undefined
  if (text[next] === ',') {
    const lineStart = lineStartOf(text, key)
    const lineEnd = nextLineStart(text, next)
    const rest = text.slice(next + 1, lineEnd).replace(/\r?\n$/, '')
    edit =
      isBlank(text.slice(lineStart, key)) &&
      isBlank(rest) &&
      !text.slice(valueEnd, next).includes('\n')
        ? removal(text, file, lineStart, lineEnd)
        : removal(text, file, key, skipSpace(text, next + 1))
  } else if (text[next] === '}' && text[previous] === ',') {
    edit = removal(text, file, previous, valueEnd)
  } else if (text[next] === '}' && text[previous] === '{') {
    edit = removal(text, file, previous + 1, next)
  }

  if (!edit) return undefined
  const after = parse(without(text, edit))
  return after !== undefined && !listed(after, field, name) ? edit : undefined
}
