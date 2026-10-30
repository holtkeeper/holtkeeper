import type { Finding, Severity } from './types.ts'

const order: Severity[] = ['unknown', 'low', 'medium', 'high', 'critical']

/** Positive when `a` is more severe than `b`. */
export const compareSeverity = (a: Severity, b: Severity) => order.indexOf(a) - order.indexOf(b)

/** Maps a CVSS base score to a severity using the CVSS v3 qualitative scale. */
export function severityFromScore(score: number): Severity {
  if (!Number.isFinite(score) || score <= 0) return 'unknown'
  if (score >= 9) return 'critical'
  if (score >= 7) return 'high'
  if (score >= 4) return 'medium'
  return 'low'
}

/** Identity of a finding that survives version changes, used to match findings across scans. */
export const findingKey = (finding: Finding) =>
  [finding.id, finding.package.ecosystem, finding.package.name, finding.source].join('\u0000')

/** Whether `id` names the finding's advisory, by primary id or by alias. */
export const matchesId = (finding: Finding, id: string) =>
  finding.id === id || finding.aliases.includes(id)

/** Groups findings by source file, keeping the order of first appearance. */
export function groupBySource(findings: readonly Finding[]): Map<string, Finding[]> {
  const groups = new Map<string, Finding[]>()
  for (const finding of findings) {
    const group = groups.get(finding.source)
    if (group) group.push(finding)
    else groups.set(finding.source, [finding])
  }
  return groups
}
