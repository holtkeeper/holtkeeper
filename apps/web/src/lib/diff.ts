import type { DiffHunk, DiffLine, FileDiff } from '@holtkeeper/api'

/** One rendered line of a unified diff with its old and new line numbers. */
export interface UnifiedRow {
  kind: DiffLine['kind']
  text: string
  old?: number
  new?: number
}

/** Numbers every line of a hunk: removals advance the old side, additions the new side. */
export function unifiedRows(hunk: DiffHunk): UnifiedRow[] {
  let oldNo = hunk.oldStart
  let newNo = hunk.newStart
  return hunk.lines.map((line) => {
    if (line.kind === 'add') return { kind: 'add', text: line.text, new: newNo++ }
    if (line.kind === 'remove') return { kind: 'remove', text: line.text, old: oldNo++ }
    return { kind: 'context', text: line.text, old: oldNo++, new: newNo++ }
  })
}

/** One side of a split-view row; absent when that side has no line there. */
export interface SplitCell {
  no: number
  text: string
  kind: DiffLine['kind']
}

export interface SplitRow {
  left?: SplitCell
  right?: SplitCell
}

/**
 * Side-by-side rows: context lines appear on both sides, and each run of removals is paired
 * line by line with the additions that follow it.
 */
export function splitRows(hunk: DiffHunk): SplitRow[] {
  const rows: SplitRow[] = []
  let removed: SplitCell[] = []
  let added: SplitCell[] = []
  const flush = () => {
    for (let i = 0; i < Math.max(removed.length, added.length); i++) {
      const left = removed[i]
      const right = added[i]
      rows.push({ ...(left ? { left } : {}), ...(right ? { right } : {}) })
    }
    removed = []
    added = []
  }
  for (const row of unifiedRows(hunk)) {
    if (row.kind === 'remove') {
      if (added.length) flush()
      removed.push({ no: row.old!, text: row.text, kind: 'remove' })
    } else if (row.kind === 'add') {
      added.push({ no: row.new!, text: row.text, kind: 'add' })
    } else {
      flush()
      rows.push({
        left: { no: row.old!, text: row.text, kind: 'context' },
        right: { no: row.new!, text: row.text, kind: 'context' },
      })
    }
  }
  flush()
  return rows
}

/** `@@ -12,3 +12,4 @@`, as in unified diffs. */
export const hunkHeader = (hunk: DiffHunk): string =>
  `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`

/** Added and removed line counts over files. */
export function diffStats(files: readonly FileDiff[]): {
  added: number
  removed: number
  files: number
} {
  let added = 0
  let removed = 0
  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === 'add') added++
        else if (line.kind === 'remove') removed++
      }
    }
  }
  return { added, removed, files: files.length }
}
