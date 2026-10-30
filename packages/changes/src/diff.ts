import { structuredPatch } from 'diff'

import type { CodeChange, DiffHunk, FileDiff } from './types.ts'

function hunksBetween(file: string, before: string, after: string, context: number): DiffHunk[] {
  return structuredPatch(file, file, before, after, '', '', { context }).hunks.map((hunk) => ({
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    lines: hunk.lines
      .filter((line) => !line.startsWith('\\'))
      .map((line) => ({
        kind: line.startsWith('+')
          ? ('add' as const)
          : line.startsWith('-')
            ? ('remove' as const)
            : ('context' as const),
        text: line.slice(1),
      })),
  }))
}

/**
 * Per-file diffs of a change, from its own `oldText`/`newText` — no repository access needed, so
 * reports can show suggestions long after the analysis ran. Hunks of `replace` edits show the
 * replaced snippet, with line numbers shifted to where it sits in the file.
 */
export function changeDiff(change: CodeChange, context = 2): FileDiff[] {
  const diffs = new Map<string, FileDiff>()
  for (const edit of change.edits) {
    if (edit.kind === 'write-binary') {
      diffs.set(edit.file, {
        file: edit.file,
        status: 'binary',
        hunks: [],
        binary: { after: edit.bytes },
      })
      continue
    }
    const entry =
      diffs.get(edit.file) ??
      ({
        file: edit.file,
        status: edit.kind === 'create' ? 'added' : edit.kind === 'delete' ? 'deleted' : 'modified',
        hunks: [],
      } satisfies FileDiff)
    diffs.set(edit.file, entry)

    if (edit.kind === 'create')
      entry.hunks.push(...hunksBetween(edit.file, '', edit.newText, context))
    else if (edit.kind === 'delete')
      entry.hunks.push(...hunksBetween(edit.file, edit.oldText, '', context))
    else {
      const shift = edit.range.start.line - 1
      for (const hunk of hunksBetween(edit.file, edit.oldText, edit.newText, context)) {
        entry.hunks.push({
          ...hunk,
          oldStart: hunk.oldStart + shift,
          newStart: hunk.newStart + shift,
        })
      }
    }
  }
  return [...diffs.values()]
}

/** One file of `unifiedDiff`: text before and after, or `bytes` for a file written as binary. */
export interface DiffInput {
  file: string
  before: string | undefined
  after: string | undefined
  /** New contents of a binary file; it is listed in a trailing note instead of diffed. */
  bytes?: Uint8Array
}

/**
 * A unified diff of several changes for `git apply`, built from the files' current contents.
 * Binary files cannot be expressed as text hunks; they are named in a trailing `#` comment block,
 * which `git apply` ignores.
 */
export function unifiedDiff(files: DiffInput[]): string {
  const binaries = files.filter((entry) => entry.bytes)
  const note = binaries.length
    ? [
        '# Binary files not included in this patch:',
        ...binaries.map(
          ({ file, before, bytes }) =>
            `#   ${file} (${bytes?.byteLength ?? 0} bytes, ${before === undefined ? 'new' : 'replaced'})`,
        ),
      ].join('\n') + '\n'
    : ''
  const text = files.filter((entry) => !entry.bytes)
  if (!text.length) return note
  return text
    .map(({ file, before, after }) => {
      const hunks = hunksBetween(file, before ?? '', after ?? '', 3)
      const header = [
        `diff --git a/${file} b/${file}`,
        ...(before === undefined
          ? ['new file mode 100644']
          : after === undefined
            ? ['deleted file mode 100644']
            : []),
        `--- ${before === undefined ? '/dev/null' : `a/${file}`}`,
        `+++ ${after === undefined ? '/dev/null' : `b/${file}`}`,
      ]
      const body = hunks.flatMap((hunk) => [
        `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
        ...hunk.lines.map(
          (line) => `${line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}${line.text}`,
        ),
      ])
      return [...header, ...body].join('\n')
    })
    .join('\n')
    .concat('\n', note)
}
