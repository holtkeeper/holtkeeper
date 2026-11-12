import { analysisMetrics } from '@holtkeeper/analyzer'
import { builtinAnalyzers } from '@holtkeeper/analyzers'
import type { AnalysisSummary } from '@holtkeeper/api'
import type { AnalysisKind } from '@holtkeeper/report'
import type {
  AnalysisHead,
  AnalysisMetrics,
  AnalysisQuery,
  AnalysisRecord,
  AnalysisStore,
} from '@holtkeeper/store'

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
export function mainLineRecords<Item extends Pick<AnalysisHead, 'ref'>>(
  records: readonly Item[],
  limit: number,
): Item[] {
  const ref = records.some((record) => !record.ref) ? undefined : records[0]?.ref
  return records.filter((record) => record.ref === ref).slice(0, limit)
}

/** Records kept per store in the cache of metrics computed at read time. */
const COMPUTED_KEEP = 10_000

/** Metrics computed for records stored without them, by record id; `null` when they cannot be. */
const computedByStore = new WeakMap<object, Map<string, AnalysisMetrics | null>>()

const computedOf = (analyses: object) => {
  let computed = computedByStore.get(analyses)
  if (!computed) computedByStore.set(analyses, (computed = new Map()))
  if (computed.size > COMPUTED_KEEP) computed.clear()
  return computed
}

/**
 * The newest record head per repository and kind on its main line (`mainLineRecords`: a newer run
 * on another branch does not replace the default branch's), of `query` only, with `metrics` filled
 * in for heads stored without them (records written before metrics existed). Those are computed
 * from the records' data with default options, read once per kind that misses them and kept in
 * process per record id, failures included, so a later call reads no data for the same records.
 * Heads whose metrics cannot be computed stay without. Only for the newest records: history keeps
 * what was stored.
 */
export async function latestHeadsWithMetrics(
  analyses: Pick<AnalysisStore, 'latest' | 'latestHeads' | 'heads' | 'get'>,
  // oxlint-disable-next-line typescript/no-explicit-any -- kinds differ in their data type
  kinds: ReadonlyMap<string, AnalysisKind<any, any>>,
  query: Pick<AnalysisQuery, 'repo' | 'kind'> = {},
): Promise<AnalysisHead[]> {
  const newest = await analyses.latestHeads(query)
  const heads = await Promise.all(
    newest.map(async (head) => {
      if (head.ref === undefined) return head
      const line = await analyses.heads({ repo: head.repo, kind: head.kind, limit: LINE_SCAN })
      return mainLineRecords(line, 1)[0] ?? head
    }),
  )
  const computed = computedOf(analyses)
  const missing = heads.filter(
    (head) => !head.metrics && !!kinds.get(head.kind)?.metrics && !computed.has(head.id),
  )
  if (missing.length) {
    const newestIds = new Set(newest.map((head) => head.id))
    const missingKinds = new Set(
      missing.filter((head) => newestIds.has(head.id)).map((head) => head.kind),
    )
    const records = await Promise.all([
      ...[...missingKinds].map((kind) => analyses.latest({ ...query, kind })),
      ...missing
        .filter((head) => !newestIds.has(head.id))
        .map(async (head) => {
          const record = await analyses.get(head.id)
          return record ? [record] : []
        }),
    ])
    const data = new Map(records.flat().map((record) => [record.id, record.data]))
    for (const head of missing)
      if (data.has(head.id))
        computed.set(head.id, analysisMetrics(kinds.get(head.kind), data.get(head.id)) ?? null)
  }
  return heads.map((head) => {
    const metrics = head.metrics ? undefined : computed.get(head.id)
    return metrics ? { ...head, metrics } : head
  })
}
