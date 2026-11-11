import { builtinAnalyzers } from '@holtkeeper/analyzers'
import type { AnalysisSummary } from '@holtkeeper/api'
import type { AnalysisKind } from '@holtkeeper/report'
import type { AnalysisRecord } from '@holtkeeper/store'

/** Analysis kinds every server understands: those of the built-in analyzers. */
// oxlint-disable-next-line typescript/no-explicit-any -- kinds differ in their data type
export const builtinAnalyses: AnalysisKind<any>[] = [
  ...new Map(
    builtinAnalyzers.map((analyzer) => [analyzer.analysis.kind, analyzer.analysis]),
  ).values(),
]

/**
 * The list view of a record; records of kinds the server does not know, or whose data an older
 * release wrote in a shape the kind no longer reads, have no metrics.
 */
export function summarizeAnalysis(
  // oxlint-disable-next-line typescript/no-explicit-any -- kinds differ in their data type
  kinds: ReadonlyMap<string, AnalysisKind<any>>,
  record: AnalysisRecord,
): AnalysisSummary {
  const kind = kinds.get(record.kind)
  let metrics: AnalysisSummary['metrics'] = []
  try {
    if (kind) metrics = kind.summarize(record.data)
  } catch {
    metrics = []
  }
  return {
    id: record.id,
    repo: record.repo,
    kind: record.kind,
    label: kind?.label ?? record.kind,
    ...(record.ref ? { ref: record.ref } : {}),
    ...(record.sha ? { sha: record.sha } : {}),
    createdAt: record.createdAt,
    ...(record.actor ? { actor: record.actor } : {}),
    metrics,
  }
}

/** Records read to find enough of one line of history among runs on other branches. */
export const LINE_SCAN = 60

/**
 * The records of one line of history, newest first, at most `limit`: those without a ref (runs on
 * the default branch), or, when every record names a ref, those on the newest record's ref. Runs
 * someone started on another branch are left out, so they do not show as the repository's state.
 */
export function mainLineRecords(
  records: readonly AnalysisRecord[],
  limit: number,
): AnalysisRecord[] {
  const ref = records.some((record) => !record.ref) ? undefined : records[0]?.ref
  return records.filter((record) => record.ref === ref).slice(0, limit)
}
