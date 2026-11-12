import type { RepoRef } from '@holtkeeper/forge'
import type { AnalysisKind, MetricsContext } from '@holtkeeper/report'
import type { AnalysisHead, AnalysisMetrics, AnalysisStore, Timestamp } from '@holtkeeper/store'

// oxlint-disable-next-line typescript/no-explicit-any -- kinds differ in their data and metrics types
type AnyKind = AnalysisKind<any, any>

/** Records of one repository and kind looked at to find the previous one on the same line. */
const PREVIOUS_SCAN = 20

/**
 * Metrics of `data` as `kind` defines them, as plain JSON. `undefined` when the kind is unknown or
 * defines no metrics, or when `data` does not pass the kind's schema (a shape an older release
 * wrote) or the kind throws on it. Never throws.
 */
export function analysisMetrics(
  kind: AnyKind | undefined,
  data: unknown,
  context: MetricsContext<AnalysisMetrics> = {},
): AnalysisMetrics | undefined {
  if (!kind?.metrics) return undefined
  try {
    const parsed = kind.schema.safeParse(data)
    if (!parsed.success) return undefined
    const metrics: unknown = JSON.parse(JSON.stringify(kind.metrics(parsed.data, context)))
    return typeof metrics === 'object' && metrics !== null ? metrics : undefined
  } catch {
    return undefined
  }
}

/**
 * The metrics to store with a new record of `kind`: computed from `data` with `options`, and with
 * the previous record's metrics for deltas. The previous record is the newest one created before
 * `createdAt` (now when absent) on the same line of history: one with the same ref, or for a
 * record with a ref and no earlier record on that ref, one without a ref (the default branch).
 * Runs on other branches are left out. Its stored metrics are used, or computed from its data when
 * it has none. The kind also gets `createdAt` when given. `undefined` whenever `analysisMetrics` is;
 * never throws.
 */
export async function recordMetrics(
  analyses: Pick<AnalysisStore, 'heads' | 'get'>,
  kind: AnyKind | undefined,
  record: { repo: RepoRef; ref?: string; createdAt?: Timestamp; data: unknown },
  options?: unknown,
): Promise<AnalysisMetrics | undefined> {
  if (!kind?.metrics) return undefined
  let previous: AnalysisMetrics | undefined
  try {
    const heads = await analyses.heads({
      repo: record.repo,
      kind: kind.kind,
      ...(record.createdAt ? { before: record.createdAt } : {}),
      limit: PREVIOUS_SCAN,
    })
    const head =
      heads.find((candidate) => candidate.ref === record.ref) ??
      heads.find((candidate) => candidate.ref === undefined)
    if (head?.metrics) previous = head.metrics
    else if (head) {
      const stored = await analyses.get(head.id)
      if (stored)
        previous = analysisMetrics(kind, stored.data, { options, createdAt: stored.createdAt })
    }
  } catch {
    previous = undefined
  }
  return analysisMetrics(kind, record.data, {
    ...(options === undefined ? {} : { options }),
    ...(previous ? { previous } : {}),
    ...(record.createdAt ? { createdAt: record.createdAt } : {}),
  })
}

/**
 * The stored metrics of `record` typed as `kind` defines them; `undefined` when the record is of
 * another kind or has none.
 */
export function metricsOf<Metrics extends AnalysisMetrics>(
  // oxlint-disable-next-line typescript/no-explicit-any -- only the metrics type matters here
  kind: AnalysisKind<any, Metrics>,
  record: Pick<AnalysisHead, 'kind' | 'metrics'>,
): Metrics | undefined {
  if (record.kind !== kind.kind || record.metrics === undefined) return undefined
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a kind's own `metrics` wrote them
  return record.metrics as Metrics
}
