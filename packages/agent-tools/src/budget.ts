/** Output limits every tool respects; results never exceed them and say how much was left out. */
export interface Budget {
  /** Most lines one tool result may have, the truncation marker included. */
  maxResultLines: number
  /** Longer lines are clipped with `…`. */
  maxLineLength: number
  /** Most hits a search reports before `… N more`. */
  maxHits: number
  /** Most lines of one matched snippet. */
  snippetLines: number
}

export const DEFAULT_BUDGET: Readonly<Budget> = {
  maxResultLines: 200,
  maxLineLength: 200,
  maxHits: 50,
  snippetLines: 5,
}

/** `DEFAULT_BUDGET` with the given overrides; non-positive values are ignored. */
export function budgetOf(overrides: Partial<Budget> = {}): Budget {
  const budget = { ...DEFAULT_BUDGET }
  const keys = ['maxResultLines', 'maxLineLength', 'maxHits', 'snippetLines'] as const
  for (const key of keys) {
    const value = overrides[key]
    if (typeof value === 'number' && value > 0) budget[key] = Math.floor(value)
  }
  return budget
}

/** `line` cut to `max` characters, with `…` when something was cut. */
export function clip(line: string, max: number): string {
  return line.length > max ? `${line.slice(0, max)}…` : line
}

/** The marker that replaces left-out output. */
export function moreMarker(count: number, unit: string): string {
  return `… ${count} more ${unit}`
}

/** At most `max` lines; when there are more, the last one is the `… N more <unit>` marker. */
export function limitLines(lines: readonly string[], max: number, unit = 'lines'): string[] {
  if (lines.length <= max) return [...lines]
  const kept = Math.max(0, max - 1)
  return [...lines.slice(0, kept), moreMarker(lines.length - kept, unit)]
}

/**
 * Renders whole blocks (one per hit) while they fit in `maxLines` and at most `maxBlocks` of
 * them; the rest is summarized as `… N more <unit>`. A block is never cut in the middle unless
 * the first block alone is too long.
 */
export function renderBlocks(
  blocks: readonly (readonly string[])[],
  budget: Pick<Budget, 'maxResultLines' | 'maxHits'>,
  unit: string,
): string {
  const out: string[] = []
  let shown = 0
  for (const block of blocks) {
    if (shown >= budget.maxHits) break
    if (out.length + block.length > budget.maxResultLines - 1) {
      if (shown === 0) {
        out.push(...block.slice(0, budget.maxResultLines - 1))
        shown++
      }
      break
    }
    out.push(...block)
    shown++
  }
  if (shown < blocks.length) out.push(moreMarker(blocks.length - shown, unit))
  return out.join('\n')
}
