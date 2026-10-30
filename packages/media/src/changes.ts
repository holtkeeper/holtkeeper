import {
  type CodeChange,
  type Edit,
  type FileDiff,
  type Range,
  changeDiff,
} from '@holtkeeper/changes'
import type { ChangeItem, Tone } from '@holtkeeper/report'
import { z } from 'zod'

export type { CodeChange, Edit, Range }

/** A binary file produced by a run and referenced by `write-binary` edits through `artifact`. */
export interface Artifact {
  /** SHA-256 of `data`, hex; equals the edit's `artifact`. */
  sha256: string
  bytes: number
  data: Uint8Array
}

const position = z.object({
  line: z.number().int().positive(),
  column: z.number().int().positive(),
})

/** Validates an `Edit`, including `write-binary`. */
export const editSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('replace'),
    file: z.string().min(1),
    range: z.object({ start: position, end: position }),
    oldText: z.string(),
    newText: z.string(),
  }),
  z.object({ kind: z.literal('create'), file: z.string().min(1), newText: z.string() }),
  z.object({ kind: z.literal('delete'), file: z.string().min(1), oldText: z.string() }),
  z.object({
    kind: z.literal('write-binary'),
    file: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    base64: z.string().optional(),
    artifact: z.string().optional(),
    previousSha256: z.string().optional(),
  }),
])

/** Validates a `CodeChange`. */
export const codeChangeSchema: z.ZodType<CodeChange> = z.object({
  id: z.string().min(1),
  title: z.string(),
  description: z.string().optional(),
  confidence: z.enum(['safe', 'review']),
  source: z.string(),
  target: z.object({ forge: z.string().min(1), path: z.string().min(1) }).optional(),
  edits: z.array(editSchema).min(1),
})

/** 1-based position of a string offset. */
export function positionAt(text: string, offset: number): { line: number; column: number } {
  let line = 1
  let start = 0
  for (
    let index = text.indexOf('\n');
    index !== -1 && index < offset;
    index = text.indexOf('\n', index + 1)
  ) {
    line++
    start = index + 1
  }
  return { line, column: offset - start + 1 }
}

/** Range of `text.slice(start, end)`. */
export const rangeOf = (text: string, start: number, end: number): Range => ({
  start: positionAt(text, start),
  end: positionAt(text, end),
})

/** A `replace` edit swapping the whole content of a file. */
export const replaceFile = (file: string, oldText: string, newText: string): Edit => ({
  kind: 'replace',
  file,
  range: rangeOf(oldText, 0, oldText.length),
  oldText,
  newText,
})

/**
 * A report `changes` item: text edits are diffed with `changeDiff`; binary writes appear as files
 * without hunks (`added`, or `modified` when they replace content).
 */
export function changeItem(
  change: CodeChange,
  extra: { tone?: Tone; tags?: string[] } = {},
): ChangeItem {
  const text = change.edits.filter((edit) => edit.kind !== 'write-binary')
  const diff: FileDiff[] = text.length ? changeDiff({ ...change, edits: text }) : []
  for (const edit of change.edits) {
    if (edit.kind !== 'write-binary') continue
    diff.push({ file: edit.file, status: edit.previousSha256 ? 'modified' : 'added', hunks: [] })
  }
  return { change, diff, ...extra }
}
