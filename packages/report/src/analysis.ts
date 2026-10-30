import type { CodeChange } from '@holtkeeper/changes'
import type { AnalysisRecord } from '@holtkeeper/store'
import type { z } from 'zod'

import type { Metric, Report } from './model.ts'

/**
 * One kind of analysis (changelog, bundle sizes, dependency graph, ...). Analyzers produce `Data`;
 * the kind validates it on ingest and turns it into reports. Adding a kind touches nothing else:
 * register it with the server and every client can show it.
 */
export interface AnalysisKind<Data = unknown> {
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
}

export const defineAnalysis = <Data>(kind: AnalysisKind<Data>): AnalysisKind<Data> => kind
