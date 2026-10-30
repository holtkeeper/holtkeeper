/** One line of a parsed hunk with its numbers on each side; removed lines have no `newLine`. */
export interface HunkLine {
  kind: 'context' | 'add' | 'remove'
  text: string
  oldLine?: number
  newLine?: number
}

export interface ParsedHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: HunkLine[]
}

const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * Parses a unified diff body (`@@` hunks, optionally preceded by `---`/`+++` headers) into hunks
 * whose lines carry their old and new line numbers. `\ No newline` markers are dropped.
 */
export function parseHunks(diff: string): ParsedHunk[] {
  const hunks: ParsedHunk[] = []
  let current: ParsedHunk | undefined
  let oldLine = 0
  let newLine = 0
  const lines = diff.split('\n')
  if (lines.at(-1) === '') lines.pop()
  for (const line of lines) {
    const match = header.exec(line)
    if (match) {
      current = {
        oldStart: Number(match[1]),
        oldLines: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newLines: match[4] === undefined ? 1 : Number(match[4]),
        lines: [],
      }
      hunks.push(current)
      oldLine = current.oldStart
      newLine = current.newStart
      continue
    }
    if (!current || line.startsWith('\\')) continue
    const marker = line[0]
    const text = line.slice(1)
    if (marker === '+') current.lines.push({ kind: 'add', text, newLine: newLine++ })
    else if (marker === '-') current.lines.push({ kind: 'remove', text, oldLine: oldLine++ })
    else if (marker === ' ' || line === '')
      current.lines.push({ kind: 'context', text, oldLine: oldLine++, newLine: newLine++ })
  }
  return hunks
}

/** New-side line numbers of added lines. */
export function addedLines(hunks: readonly ParsedHunk[]): Set<number> {
  const lines = new Set<number>()
  for (const hunk of hunks)
    for (const line of hunk.lines) if (line.kind === 'add' && line.newLine) lines.add(line.newLine)
  return lines
}

/** New-side lines the diff shows (added and context), by number. Forges accept comments on these. */
export function newSideLines(hunks: readonly ParsedHunk[]): Map<number, string> {
  const lines = new Map<number, string>()
  for (const hunk of hunks)
    for (const line of hunk.lines) if (line.newLine) lines.set(line.newLine, line.text)
  return lines
}

/** Number of added plus removed lines. */
export const changedLineCount = (hunks: readonly ParsedHunk[]) =>
  hunks.reduce((sum, hunk) => sum + hunk.lines.filter((l) => l.kind !== 'context').length, 0)

/**
 * The changed line closest to `line` within `maxDistance`, preferring the earlier one on a tie;
 * `undefined` when none is that close.
 */
export function nearestLine(
  lines: Iterable<number>,
  line: number,
  maxDistance: number,
): number | undefined {
  let best: number | undefined
  for (const candidate of lines) {
    const distance = Math.abs(candidate - line)
    if (distance > maxDistance) continue
    if (
      best === undefined ||
      distance < Math.abs(best - line) ||
      (distance === Math.abs(best - line) && candidate < best)
    )
      best = candidate
  }
  return best
}

/**
 * A hunk-by-hunk listing for the agent: each new-side line prefixed with its number. In-scope added
 * lines are marked `+`, added lines outside the scope (already reviewed) `~`, removed lines `-`
 * without a number. Hunks without any in-scope line are left out.
 */
export function renderNumberedDiff(
  path: string,
  hunks: readonly ParsedHunk[],
  inScope: ReadonlySet<number>,
): string {
  const width = String(Math.max(1, ...hunks.map((h) => h.newStart + h.newLines))).length
  const blocks = hunks
    .filter((hunk) => hunk.lines.some((line) => line.newLine && inScope.has(line.newLine)))
    .map((hunk) => {
      const body = hunk.lines.map((line) => {
        if (line.kind === 'remove') return `${' '.repeat(width)} - ${line.text}`
        const number = String(line.newLine).padStart(width)
        const mark = line.kind === 'context' ? ' ' : inScope.has(line.newLine ?? 0) ? '+' : '~'
        return `${number} ${mark} ${line.text}`
      })
      return [
        `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
        ...body,
      ].join('\n')
    })
  return blocks.length ? [`### ${path}`, ...blocks].join('\n') : ''
}
