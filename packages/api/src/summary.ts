import type { AuditRun } from '@holtkeeper/store'

import { sourceInfo } from './sources.ts'
import type { AuditRunSummary, SeverityCounts } from './types.ts'

export const emptySeverities = (): SeverityCounts => ({
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
  unknown: 0,
})

/** Condenses a run for lists and charts. Pure, so the server and the UI compute the same numbers. */
export function summarizeRun(run: AuditRun): AuditRunSummary {
  const { report } = run
  const severities = emptySeverities()
  for (const finding of report.findings) severities[finding.severity]++

  const sources = [
    ...report.findings,
    ...report.resolved,
    ...report.ignored.map((i) => i.finding),
  ].map((f) => sourceInfo(f.source))
  return {
    id: run.id,
    repo: run.repo,
    trigger: run.trigger,
    ...(run.actor ? { actor: run.actor } : {}),
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    severities,
    active: report.findings.length,
    ignored: report.ignored.length,
    resolved: report.resolved.length,
    expiredAllowlist: report.expired.length,
    languages: [...new Set(sources.map((s) => s.language))].toSorted(),
    tools: [...new Set(sources.map((s) => s.label))].toSorted(),
    changedFiles: report.changedFiles.length,
  }
}
