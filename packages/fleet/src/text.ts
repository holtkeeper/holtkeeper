import type { Edit, Position } from '@holtkeeper/changes'

/** 1-based position of a character offset. */
export function positionAt(text: string, offset: number): Position {
  let line = 1
  let lineStart = 0
  for (
    let index = text.indexOf('\n');
    index !== -1 && index < offset;
    index = text.indexOf('\n', index + 1)
  ) {
    line++
    lineStart = index + 1
  }
  return { line, column: offset - lineStart + 1 }
}

/** A text splice by character offsets: `[start, end)` becomes `newText`. */
export interface Splice {
  start: number
  end: number
  newText: string
}

/** `replace` edits for splices of `text`; splices at the same offset are merged in order. */
export function splicesToEdits(file: string, text: string, splices: Splice[]): Edit[] {
  const merged: Splice[] = []
  for (const splice of splices.toSorted((a, b) => a.start - b.start)) {
    const last = merged.at(-1)
    if (
      last &&
      last.start === splice.start &&
      last.end === last.start &&
      splice.end === splice.start
    )
      last.newText += splice.newText
    else merged.push({ ...splice })
  }
  return merged.map(({ start, end, newText }) => ({
    kind: 'replace',
    file,
    range: { start: positionAt(text, start), end: positionAt(text, end) },
    oldText: text.slice(start, end),
    newText,
  }))
}

/** CRLF to LF, so files edited on Windows do not count as drifted. */
export const normalizeNewlines = (text: string) => text.replaceAll('\r\n', '\n')

/** Leading whitespace of the line containing `offset`. */
export function indentAt(text: string, offset: number): string {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1
  return /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? ''
}

/** The indentation unit a file uses: its first indented line's whitespace, else two spaces. */
export function indentUnit(text: string): string {
  return /\n([ \t]+)\S/.exec(text)?.[1] ?? '  '
}
