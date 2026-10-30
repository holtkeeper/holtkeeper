import { createHash } from 'node:crypto'

import type { DiffRefs, ReviewComment } from '@holtkeeper/forge'

/** One line of a parsed unified diff with GitLab's line counters on both sides. */
export interface DiffLine {
  kind: 'added' | 'removed' | 'context'
  /** Old-side counter; for an added line, the old line that follows it. */
  old: number
  /** New-side counter; for a removed line, the new line that follows it. */
  new: number
}

/** A hunk of a unified diff as parsed by `parseHunks`. */
export interface Hunk {
  lines: DiffLine[]
  /** Counters after the last line of the hunk. */
  oldEnd: number
  newEnd: number
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/** Hunks of a unified diff body, counting lines the way GitLab's diff parser does. */
export function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = []
  let current: Hunk | undefined
  let oldLine = 0
  let newLine = 0
  for (const text of diff.replace(/\n$/, '').split('\n')) {
    const header = HUNK.exec(text)
    if (header) {
      oldLine = Number(header[1])
      newLine = Number(header[2])
      current = { lines: [], oldEnd: oldLine, newEnd: newLine }
      hunks.push(current)
      continue
    }
    if (!current || text.startsWith('\\')) continue
    if (text.startsWith('+')) {
      current.lines.push({ kind: 'added', old: oldLine, new: newLine })
      newLine++
    } else if (text.startsWith('-')) {
      current.lines.push({ kind: 'removed', old: oldLine, new: newLine })
      oldLine++
    } else if (text.startsWith(' ') || text === '') {
      current.lines.push({ kind: 'context', old: oldLine, new: newLine })
      oldLine++
      newLine++
    }
    current.oldEnd = oldLine
    current.newEnd = newLine
  }
  return hunks
}

/**
 * The diff line at `line` on `side`. Lines outside every hunk are unchanged, so their other-side
 * number is shifted by the hunks above them.
 */
export function locateLine(hunks: Hunk[], line: number, side: 'new' | 'old'): DiffLine {
  let shift = 0
  for (const hunk of hunks) {
    const found = hunk.lines.find((l) =>
      side === 'new'
        ? l.kind !== 'removed' && l.new === line
        : l.kind !== 'added' && l.old === line,
    )
    if (found) return found
    const end = side === 'new' ? hunk.newEnd : hunk.oldEnd
    if (end <= line) shift = hunk.newEnd - hunk.oldEnd
  }
  return side === 'new'
    ? { kind: 'context', old: line - shift, new: line }
    : { kind: 'context', old: line, new: line + shift }
}

/** GitLab's line code: `<sha1(path)>_<old>_<new>`. */
export function lineCode(path: string, line: DiffLine): string {
  return `${createHash('sha1').update(path).digest('hex')}_${line.old}_${line.new}`
}

/** GitLab accepts at most this many lines above the commented line in a suggestion. */
const MAX_SUGGESTION_ABOVE = 100

/**
 * The comment body with its suggestion as a GitLab suggestion block. `-N` counts the lines above
 * the commented line that the replacement covers. The fence is longer than any backtick run in
 * the replacement, so code blocks inside it survive.
 */
export function renderBody(comment: ReviewComment): string {
  if (!comment.suggestion) return comment.body
  const above = comment.startLine === undefined ? 0 : comment.line - comment.startLine
  const raw = comment.suggestion.replacement
  const content = raw === '' ? [] : [raw.replace(/\r?\n$/, '')]
  const longest = Math.max(0, ...[...raw.matchAll(/`+/g)].map((m) => m[0].length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  const block = [`${fence}suggestion:-${above}+0`, ...content, fence].join('\n')
  return comment.body ? `${comment.body}\n\n${block}` : block
}

/** Why a comment cannot be posted on GitLab, before asking GitLab; `undefined` when it can. */
export function invalidReason(comment: ReviewComment): string | undefined {
  if (!Number.isInteger(comment.line) || comment.line < 1) return 'line must be a positive integer'
  if (comment.startLine !== undefined) {
    if (!Number.isInteger(comment.startLine) || comment.startLine < 1)
      return 'startLine must be a positive integer'
    if (comment.startLine > comment.line) return 'startLine is after line'
  }
  if (comment.suggestion) {
    if (comment.side === 'old') return 'suggestions apply to the new version only'
    if (comment.line - (comment.startLine ?? comment.line) > MAX_SUGGESTION_ABOVE)
      return `GitLab suggestions cover at most ${MAX_SUGGESTION_ABOVE + 1} lines`
  }
  return undefined
}

/** The file a comment points at, as the merge request diff names it. */
export interface PositionFile {
  oldPath: string
  newPath: string
  /** Undefined when the diff body is unavailable (collapsed or too large). */
  hunks?: Hunk[]
}

const rangeEnd = (path: string, line: DiffLine) => {
  const end: Record<string, unknown> = {
    line_code: lineCode(path, line),
    type: line.kind === 'added' ? 'new' : 'old',
  }
  if (line.kind !== 'added') end['old_line'] = line.old
  if (line.kind !== 'removed') end['new_line'] = line.new
  return end
}

/**
 * A GitLab `text` position for a comment. Added lines get `new_line`, removed lines `old_line`,
 * unchanged lines both. A range (`startLine` before `line`) adds `line_range` with line codes.
 */
export function textPosition(
  refs: DiffRefs,
  file: PositionFile,
  comment: ReviewComment,
): Record<string, unknown> {
  const side = comment.side ?? 'new'
  const locate = (line: number): DiffLine =>
    file.hunks
      ? locateLine(file.hunks, line, side)
      : side === 'new'
        ? { kind: 'added', old: line, new: line }
        : { kind: 'removed', old: line, new: line }
  const end = locate(comment.line)
  const position: Record<string, unknown> = {
    position_type: 'text',
    base_sha: refs.baseSha,
    start_sha: refs.startSha,
    head_sha: refs.headSha,
    old_path: file.oldPath,
    new_path: file.newPath,
  }
  if (end.kind !== 'added') position['old_line'] = end.old
  if (end.kind !== 'removed') position['new_line'] = end.new
  if (comment.startLine !== undefined && comment.startLine < comment.line) {
    const codePath = file.newPath || file.oldPath
    position['line_range'] = {
      start: rangeEnd(codePath, locate(comment.startLine)),
      end: rangeEnd(codePath, end),
    }
  }
  return position
}
