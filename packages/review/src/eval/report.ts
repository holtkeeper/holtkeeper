import type { QualityGroup, QualityRow } from '../quality.ts'
import type { CaseResult, EvalSummary } from './score.ts'
import { summarize } from './score.ts'

const percent = (value: number) => `${(value * 100).toFixed(0)}%`
const minutes = (ms: number) =>
  ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${Math.round(ms / 1000)} s`

/** The headline numbers of a summary, one per line. */
export function formatSummary(summary: EvalSummary): string[] {
  return [
    `precision ${percent(summary.precision)}   recall ${percent(summary.recall)}   f1 ${percent(summary.f1)}`,
    `problems found ${summary.found}/${summary.expected}, underrated ${summary.underrated}`,
    `comments ${summary.comments}: ${summary.matched} on a problem, ${summary.falsePositives} false positives, ${summary.duplicates} duplicates`,
    `clean changes ${summary.cleanFlagged}/${summary.cleanRuns} drew a comment`,
    `${summary.runs} runs${summary.errors ? `, ${summary.errors} FAILED` : ''}, $${summary.costUsd.toFixed(2)}, ${summary.turns} turns, ${minutes(summary.durationMs)}`,
  ]
}

const label = (result: CaseResult) => `${result.caseId}${result.run > 1 ? `#${result.run}` : ''}`

/**
 * A readable report of an eval: the summary, then what to look at: failed runs, missed problems,
 * underrated ones and false positives, with the cases they belong to.
 */
export function formatEval(results: readonly CaseResult[]): string {
  const lines = formatSummary(summarize(results))
  const section = (title: string, entries: string[]) => {
    if (entries.length) lines.push('', `${title}:`, ...entries.map((entry) => `  ${entry}`))
  }
  section(
    'Failed runs',
    results.flatMap((result) => (result.error ? [`${label(result)}: ${result.error}`] : [])),
  )
  section(
    'Missed',
    results.flatMap((result) =>
      result.error ? [] : result.score.missed.map((id) => `${label(result)}: ${id}`),
    ),
  )
  section(
    'Underrated',
    results.flatMap((result) => result.score.underrated.map((id) => `${label(result)}: ${id}`)),
  )
  section(
    'False positives',
    results.flatMap((result) =>
      result.score.comments
        .filter((comment) => !comment.matched)
        .map(
          (comment) =>
            `${label(result)}: ${comment.path}:${comment.line} [${comment.severity}/${comment.category}] ${comment.title}`,
        ),
    ),
  )
  return lines.join('\n')
}

const cell = (value: number | undefined) => (value === undefined ? '-' : percent(value))

/** A table of what became of the comments of real merge requests, one row per group. */
export function formatQuality(
  by: QualityGroup,
  rows: readonly QualityRow[],
  total: QualityRow,
): string {
  const table = [by, 'comments', 'fixed', 'resolved', 'ignored', 'unknown', 'accepted', 'addressed']
  const body = [...rows, { ...total, key: 'all' }].map((row) => [
    row.key,
    String(row.comments),
    String(row.fixed),
    String(row.resolved),
    String(row.ignored),
    String(row.unknown),
    cell(row.acceptance),
    cell(row.addressed),
  ])
  const widths = table.map((head, column) =>
    Math.max(head.length, ...body.map((row) => row[column]?.length ?? 0)),
  )
  const render = (row: string[]) =>
    row
      .map((value, column) => value.padEnd(widths[column] ?? 0))
      .join('  ')
      .trimEnd()
  return [render(table), ...body.map(render)].join('\n')
}
