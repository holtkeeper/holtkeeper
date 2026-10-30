import type { Edit, Position, Range } from '@holtkeeper/changes'

/** 1-based position of a UTF-16 offset. */
function positionAt(text: string, offset: number): Position {
  const before = text.slice(0, offset)
  const lineStart = before.lastIndexOf('\n') + 1
  let line = 1
  for (let index = before.indexOf('\n'); index !== -1; index = before.indexOf('\n', index + 1))
    line++
  return { line, column: offset - lineStart + 1 }
}

const rangeOf = (text: string, start: number, end: number): Range => ({
  start: positionAt(text, start),
  end: positionAt(text, end),
})

export type ReplaceEdit = Extract<Edit, { kind: 'replace' }>

/** A `replace` edit removing `text.slice(start, end)`. */
export function removal(text: string, file: string, start: number, end: number): ReplaceEdit {
  return {
    kind: 'replace',
    file,
    range: rangeOf(text, start, end),
    oldText: text.slice(start, end),
    newText: '',
  }
}

export const isBlank = (text: string) => /^[ \t]*$/.test(text)

/** Index of the first character at or after `from` that is not whitespace. */
export function skipSpace(text: string, from: number): number {
  let index = from
  while (index < text.length && /\s/.test(text[index] ?? '')) index++
  return index
}

/** Index of the last character before `from` that is not whitespace, or -1. */
export function skipSpaceBack(text: string, from: number): number {
  let index = from - 1
  while (index >= 0 && /\s/.test(text[index] ?? '')) index--
  return index
}

/** Offset just past the line break ending the line that contains `offset`, or the text length. */
export function nextLineStart(text: string, offset: number): number {
  const index = text.indexOf('\n', offset)
  return index === -1 ? text.length : index + 1
}

export const lineStartOf = (text: string, offset: number) => text.lastIndexOf('\n', offset - 1) + 1
