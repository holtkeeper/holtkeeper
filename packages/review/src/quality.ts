import type { ReactionSignal } from '@holtkeeper/store'

/** What `qualityRows` groups comments by. */
export const qualityGroups = ['category', 'severity', 'model', 'promptVersion', 'source'] as const
export type QualityGroup = (typeof qualityGroups)[number]

/** Outcomes and reactions of the comments of one group. */
export interface QualityRow {
  /** The group's value, or `unknown` for signals stored without it. */
  key: string
  /** Comments of merged merge requests in the group. */
  comments: number
  fixed: number
  resolved: number
  ignored: number
  unknown: number
  up: number
  down: number
  /**
   * Share of judged comments (`fixed + resolved + ignored`) whose lines were changed afterwards;
   * absent when none is judged.
   */
  acceptance?: number
  /** Share of judged comments that were fixed or resolved; absent when none is judged. */
  addressed?: number
}

const emptyRow = (key: string): QualityRow => ({
  key,
  comments: 0,
  fixed: 0,
  resolved: 0,
  ignored: 0,
  unknown: 0,
  up: 0,
  down: 0,
})

function finish(row: QualityRow): QualityRow {
  const judged = row.fixed + row.resolved + row.ignored
  return judged
    ? { ...row, acceptance: row.fixed / judged, addressed: (row.fixed + row.resolved) / judged }
    : row
}

/**
 * Acceptance of Holtkeeper's review comments per `by`, most comments first (then by key). Only
 * comments of merged merge requests with a read outcome count: a closed merge request says
 * nothing about whether a finding was right, and signals stored before outcomes existed carry
 * none. The `total` row sums every counted comment.
 */
export function qualityRows(
  signals: Iterable<ReactionSignal>,
  by: QualityGroup,
): { rows: QualityRow[]; total: QualityRow } {
  const rows = new Map<string, QualityRow>()
  const total = emptyRow('total')
  for (const signal of signals) {
    if (signal.mergeRequestState !== 'merged' || !signal.outcome) continue
    const key = signal[by] ?? 'unknown'
    const row = rows.get(key) ?? emptyRow(key)
    for (const target of [row, total]) {
      target.comments++
      target[signal.outcome]++
      target.up += signal.up
      target.down += signal.down
    }
    rows.set(key, row)
  }
  return {
    rows: [...rows.values()]
      .map(finish)
      .toSorted((a, b) => b.comments - a.comments || a.key.localeCompare(b.key)),
    total: finish(total),
  }
}
