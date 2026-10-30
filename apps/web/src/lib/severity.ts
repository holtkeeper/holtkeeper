import type { Severity, SeverityCounts } from '@holtkeeper/api'

/** Severities from worst to least severe. */
export const severities = [
  'critical',
  'high',
  'medium',
  'low',
  'unknown',
] as const satisfies readonly Severity[]

/** 0 for `critical` up to 4 for `unknown`; sorts ascending from worst. */
export const severityRank = (severity: Severity): number => severities.indexOf(severity)

export const severityLabel: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  unknown: 'Unknown',
}

/** Worst severity with a non-zero count, or `undefined` when everything is zero. */
export function worstSeverity(counts: SeverityCounts): Severity | undefined {
  return severities.find((severity) => counts[severity] > 0)
}

/** Sum of all severities. */
export const totalOf = (counts: SeverityCounts): number =>
  severities.reduce((sum, severity) => sum + counts[severity], 0)

/** Adds `b` into a copy of `a`. */
export function addCounts(a: SeverityCounts, b: SeverityCounts): SeverityCounts {
  return {
    critical: a.critical + b.critical,
    high: a.high + b.high,
    medium: a.medium + b.medium,
    low: a.low + b.low,
    unknown: a.unknown + b.unknown,
  }
}

/** Orders by worst severity first, then by count of each level; for "needs attention" lists. */
export function compareCounts(a: SeverityCounts, b: SeverityCounts): number {
  for (const severity of severities) {
    if (a[severity] !== b[severity]) return b[severity] - a[severity]
  }
  return 0
}
