import { analysisMetrics } from '@holtkeeper/analyzer'
import type { AnalysisKind } from '@holtkeeper/report'
import type { AnalysisHead, AnalysisMetrics, AnalysisStore } from '@holtkeeper/store'

/**
 * `heads` with metrics a fleet table can use: a head whose stored metrics `current` rejects (written
 * by an older release, without fields added since) gets them recomputed from its record's data,
 * stored fields kept over computed ones so deltas against earlier records survive. Reads one record
 * per such head only; heads whose data no longer passes the kind's schema keep what they have.
 */
export async function withCurrentMetrics(
  analyses: Pick<AnalysisStore, 'get'>,
  // oxlint-disable-next-line typescript/no-explicit-any -- only the metrics are read
  kind: AnalysisKind<any, any> | undefined,
  heads: readonly AnalysisHead[],
  current: (metrics: AnalysisMetrics) => boolean,
): Promise<AnalysisHead[]> {
  return Promise.all(
    heads.map(async (head) => {
      if (!head.metrics || current(head.metrics)) return head
      const record = await analyses.get(head.id)
      const computed = record && analysisMetrics(kind, record.data)
      return computed ? { ...head, metrics: { ...computed, ...head.metrics } } : head
    }),
  )
}
