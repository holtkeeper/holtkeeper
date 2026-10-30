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

/** The list view of a record; records of kinds the server does not know have no metrics. */
export function summarizeAnalysis(
  // oxlint-disable-next-line typescript/no-explicit-any -- kinds differ in their data type
  kinds: ReadonlyMap<string, AnalysisKind<any>>,
  record: AnalysisRecord,
): AnalysisSummary {
  const kind = kinds.get(record.kind)
  return {
    id: record.id,
    repo: record.repo,
    kind: record.kind,
    label: kind?.label ?? record.kind,
    ...(record.ref ? { ref: record.ref } : {}),
    createdAt: record.createdAt,
    ...(record.actor ? { actor: record.actor } : {}),
    metrics: kind ? kind.summarize(record.data) : [],
  }
}
