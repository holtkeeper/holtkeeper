import type { CodeChange } from '@holtkeeper/changes'
import type { AnalysisMetrics, AnalysisRecord } from '@holtkeeper/store'
import type { z } from 'zod'

import type { Metric, Report } from './model.ts'

/** What a kind's `metrics` may use besides the record's data. */
export interface MetricsContext<Metrics> {
  /**
   * Options of the analyzer for the record's repository as configured, unvalidated and possibly
   * partial (the scoped `analyzers.<kind>` setting, or the options a job ran with). Kinds read the
   * fields they need and fall back to defaults; absent when nobody knows them.
   */
  options?: unknown
  /** Metrics of the previous record on the same line of history, for deltas. */
  previous?: Metrics
  /** When the record was created; absent when metrics are computed for an unknown time. */
  createdAt?: string
}

/**
 * One kind of analysis (changelog, bundle sizes, dependency graph, ...). Analyzers produce `Data`;
 * the kind validates it on ingest and turns it into reports. Adding a kind touches nothing else:
 * register it with the server and every client can show it.
 */
export interface AnalysisKind<Data = unknown, Metrics extends AnalysisMetrics = AnalysisMetrics> {
  kind: string
  label: string
  /** Validates data received from analyzers, e.g. uploads from CI. */
  schema: z.ZodType<Data>
  /** Headline numbers for lists and dashboards. */
  summarize(data: Data): Metric[]
  /**
   * The full report. `previous` is an earlier record of the same kind and repository (the
   * previous release, by default), so reports can show what changed.
   */
  toReport(current: AnalysisRecord<Data>, previous?: AnalysisRecord<Data>): Report
  /** Code changes the analysis suggests, by id; needed for accepting them from a report. */
  changes?(data: Data): CodeChange[]
  /**
   * Structured headline numbers of valid `data`, stored with the record as `metrics` so lists,
   * health and dashboards read them without the data. Plain JSON; deterministic for the same
   * data and context. Absent: the kind stores no metrics.
   */
  metrics?(data: Data, context: MetricsContext<Metrics>): Metrics
}

export const defineAnalysis = <Data, Metrics extends AnalysisMetrics = AnalysisMetrics>(
  kind: AnalysisKind<Data, Metrics>,
): AnalysisKind<Data, Metrics> => kind
