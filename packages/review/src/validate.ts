import { nearestLine } from './diff.ts'
import type { ReviewCategory, ReviewSeverity } from './schema.ts'
import type { FileScope } from './scope.ts'

/** A finding before it is validated, deduplicated and posted. */
export interface Candidate {
  path: string
  line: number
  startLine?: number
  severity: ReviewSeverity
  category: ReviewCategory
  title: string
  body: string
  /** `agent` or the quality check that found it. */
  source: string
  suggestion?: { replacement: string; original?: string }
}

/** How far a comment may be moved to reach a line of the diff. */
export const MAX_LINE_SHIFT = 5

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i)

const stripFinalNewline = (text: string) => (text.endsWith('\n') ? text.slice(0, -1) : text)

/**
 * Checks a suggestion against the lines it replaces: every line of `startLine..line` must be shown
 * by the diff, and the replacement must cover exactly those lines — copies of the neighbouring
 * lines the model often repeats are trimmed. Returns the suggestion with the original text, or
 * `undefined` when it cannot be applied as written or changes nothing.
 */
export function validateSuggestion(
  file: Pick<FileScope, 'visible'>,
  startLine: number,
  line: number,
  replacement: string,
): { replacement: string; original: string } | undefined {
  if (startLine > line) return undefined
  const lines = range(startLine, line)
  const texts = lines.map((n) => file.visible.get(n))
  if (texts.some((text) => text === undefined)) return undefined
  const original = texts.join('\n')

  const replaced = stripFinalNewline(replacement).split('\n')
  const before = file.visible.get(startLine - 1)
  const after = file.visible.get(line + 1)
  if (
    replaced.length > lines.length &&
    before !== undefined &&
    replaced[0] === before &&
    texts[0] !== before
  )
    replaced.shift()
  if (
    replaced.length > lines.length &&
    after !== undefined &&
    replaced.at(-1) === after &&
    texts.at(-1) !== after
  )
    replaced.pop()

  const result = replaced.join('\n')
  return result === original ? undefined : { replacement: result, original }
}

/**
 * Makes a finding postable: its file must be in scope and its line shown by the diff. A line
 * outside the diff moves to the nearest changed line (at most `MAX_LINE_SHIFT` away), which drops a
 * range and a suggestion meant for the original lines. With `inScopeOnly` (incremental reviews)
 * diff lines outside the scope were reviewed before and are rejected. Returns `undefined` when the
 * finding cannot be placed.
 */
export function validateCandidate(
  candidate: Candidate,
  files: ReadonlyMap<string, FileScope>,
  { inScopeOnly = false }: { inScopeOnly?: boolean } = {},
): Candidate | undefined {
  const file = files.get(candidate.path.replace(/^\.?\//, ''))
  if (!file) return undefined
  if (inScopeOnly && file.visible.has(candidate.line) && !file.lines.has(candidate.line))
    return undefined
  const { startLine: _start, suggestion: _suggestion, ...base } = candidate
  const result: Candidate = { ...base, path: file.path }

  if (!file.visible.has(candidate.line)) {
    const moved = nearestLine(file.lines, candidate.line, MAX_LINE_SHIFT)
    if (moved === undefined) return undefined
    result.line = moved
    return result
  }

  const start = candidate.startLine === candidate.line ? undefined : candidate.startLine
  const rangeOk =
    start !== undefined &&
    start < candidate.line &&
    range(start, candidate.line).every((n) => file.visible.has(n))
  if (rangeOk) result.startLine = start

  if (candidate.suggestion && (start === undefined || rangeOk)) {
    const suggestion = validateSuggestion(
      file,
      start ?? candidate.line,
      candidate.line,
      candidate.suggestion.replacement,
    )
    if (suggestion) result.suggestion = suggestion
  }
  return result
}
