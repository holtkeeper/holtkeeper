import { builtinAnalyzers } from '@holtkeeper/analyzers'
import type { AnalysisKind } from '@holtkeeper/report'

/** Analysis kinds every server understands: those of the built-in analyzers. */
// oxlint-disable-next-line typescript/no-explicit-any -- kinds differ in their data type
export const builtinAnalyses: AnalysisKind<any>[] = [
  ...new Map(
    builtinAnalyzers.map((analyzer) => [analyzer.analysis.kind, analyzer.analysis]),
  ).values(),
]
