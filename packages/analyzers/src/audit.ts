import { defineAnalyzer } from '@holtkeeper/analyzer'
import { type Metric, type MetricsContext, type Report, defineAnalysis } from '@holtkeeper/report'
import {
  type AuditReport,
  type Finding,
  type Severity,
  allowlistSchema,
  auditReportSchema,
  runAudit,
} from '@holtkeeper/vuln'
import { goFixer } from '@holtkeeper/vuln-go'
import { jsFixer } from '@holtkeeper/vuln-js'
import { osvFixer, osvScanner } from '@holtkeeper/vuln-osv'
import { z } from 'zod'

const severities: Severity[] = ['critical', 'high', 'medium', 'low', 'unknown']

const count = (findings: readonly Finding[], severity: Severity) =>
  findings.filter((finding) => finding.severity === severity).length

const findingRows = (findings: readonly Finding[]) =>
  findings.map((finding) => ({
    id: { text: finding.id, href: finding.url },
    severity: {
      text: finding.severity,
      tone:
        finding.severity === 'critical' || finding.severity === 'high'
          ? ('bad' as const)
          : finding.severity === 'medium'
            ? ('warning' as const)
            : ('neutral' as const),
    },
    package: `${finding.package.name}@${finding.package.version}`,
    source: finding.source,
    fix: finding.fixedVersions[0] ?? null,
  }))

const summarizeAudit = (report: AuditReport): Metric[] => [
  {
    id: 'active',
    label: 'Vulnerable',
    value: report.findings.length,
    unit: 'count',
    better: 'down',
    tone: report.findings.length ? 'bad' : 'good',
  },
  { id: 'ignored', label: 'Allowlisted', value: report.ignored.length, unit: 'count' },
  ...(report.fixes.length
    ? [{ id: 'resolved', label: 'Fixed', value: report.resolved.length, unit: 'count' as const }]
    : []),
]

/** One finding of an `audit` record as its metrics keep it, for fleet tables. */
export interface AuditFindingMetric {
  /** Primary advisory id. */
  id: string
  aliases: string[]
  summary: string
  url: string
  severity: Severity
  package: string
  /** OSV ecosystem name: `npm`, `Go`, ... */
  ecosystem: string
  version: string
  /** Lockfile or manifest it was found in. */
  source: string
  /** Versions that fix it, lowest first. */
  fixedIn: string[]
  /** Set when the allowlist hid it; `until` is the entry's last day, absent when it never expires. */
  allowlisted?: { until?: string }
}

/** Stored headline numbers of one `audit` record. */
export interface AuditMetrics {
  /** Active advisories: present after fixing and not allowlisted. */
  findings: number
  /** Active advisories per severity; every severity is present. */
  severities: Record<Severity, number>
  /** Advisories the allowlist hides. */
  ignored: number
  /** Allowlist entries past their expiry. */
  expired: number
  /** Advisories fixing removed during the run. */
  resolved: number
  /** Active and allowlisted findings, in report order. */
  advisories: AuditFindingMetric[]
  /**
   * When each finding (`auditFindingKey`) of `advisories` was first reported on this line of
   * history: carried over from the previous record, else this record's creation time. A key is
   * missing when neither is known (records written before first-seen times were stored).
   */
  firstSeen: Record<string, string>
}

/** The key of a finding in `AuditMetrics.firstSeen`: advisory and package, not version or source. */
export const auditFindingKey = (finding: { id: string; ecosystem: string; package: string }) =>
  `${finding.id}|${finding.ecosystem}|${finding.package}`

const findingMetric = (finding: Finding, until?: string | null): AuditFindingMetric => ({
  id: finding.id,
  aliases: finding.aliases,
  summary: finding.summary,
  url: finding.url,
  severity: finding.severity,
  package: finding.package.name,
  ecosystem: finding.package.ecosystem,
  version: finding.package.version,
  source: finding.source,
  fixedIn: finding.fixedVersions,
  ...(until !== undefined && { allowlisted: until === null ? {} : { until } }),
})

const previousFirstSeen = (previous: unknown): Record<string, unknown> => {
  if (typeof previous !== 'object' || previous === null || !('firstSeen' in previous)) return {}
  const { firstSeen } = previous
  return typeof firstSeen === 'object' && firstSeen !== null ? { ...firstSeen } : {}
}

/**
 * `AuditMetrics` of an audit report. First-seen times come from `context.previous` and
 * `context.createdAt`.
 */
export function auditMetrics(
  report: AuditReport,
  context: MetricsContext<AuditMetrics> = {},
): AuditMetrics {
  const advisories = [
    ...report.findings.map((finding) => findingMetric(finding)),
    ...report.ignored.map(({ finding, entry }) => findingMetric(finding, entry.expires ?? null)),
  ]
  const carried = previousFirstSeen(context.previous)
  const firstSeen: Record<string, string> = {}
  for (const advisory of advisories) {
    const key = auditFindingKey(advisory)
    const seen = carried[key]
    if (typeof seen === 'string') firstSeen[key] = seen
    else if (context.createdAt) firstSeen[key] = context.createdAt
  }
  return {
    findings: report.findings.length,
    severities: {
      critical: count(report.findings, 'critical'),
      high: count(report.findings, 'high'),
      medium: count(report.findings, 'medium'),
      low: count(report.findings, 'low'),
      unknown: count(report.findings, 'unknown'),
    },
    ignored: report.ignored.length,
    expired: report.expired.length,
    resolved: report.resolved.length,
    advisories,
    firstSeen,
  }
}

/** Vulnerability audits run as background jobs; the server also stores each one as an audit run. */
export const auditAnalysis = defineAnalysis<AuditReport, AuditMetrics>({
  kind: 'audit',
  label: 'Vulnerability audit',
  schema: auditReportSchema,
  summarize: summarizeAudit,
  metrics: auditMetrics,
  toReport(current): Report {
    const report = current.data
    return {
      kind: 'audit',
      title: 'Vulnerability audit',
      subtitle: report.scanner,
      subject: { repo: current.repo, ...(current.ref ? { ref: current.ref } : {}) },
      generatedAt: current.createdAt,
      metrics: summarizeAudit(report),
      sections: [
        {
          id: 'severities',
          title: 'By severity',
          blocks: [
            {
              type: 'metrics',
              metrics: severities.map((severity) => ({
                id: severity,
                label: severity,
                value: count(report.findings, severity),
                unit: 'count',
              })),
            },
          ],
        },
        {
          id: 'findings',
          title: 'Findings',
          blocks: [
            {
              type: 'table',
              columns: [
                { key: 'id', label: 'Advisory', format: 'code' },
                { key: 'severity', label: 'Severity' },
                { key: 'package', label: 'Package', format: 'code' },
                { key: 'source', label: 'Source', format: 'code' },
                { key: 'fix', label: 'Fixed in', format: 'code' },
              ],
              rows: findingRows(report.findings),
            },
          ],
        },
      ],
    }
  },
})

export const auditAnalyzer = defineAnalyzer({
  kind: 'audit',
  analysis: auditAnalysis,
  scope: 'repo',
  refresh: { on: 'time', cadence: '1d' },
  needs: { checkout: true },
  options: z.object({
    fix: z.boolean().default(false),
    allowlist: allowlistSchema.default([]),
    upgrade: z.enum(['major', 'minor', 'patch']).optional(),
    traits: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  }),
  async run({ dir, ref, runner, options, signal }) {
    if (!dir) throw new Error('this analyzer needs a checkout')
    const data = await runAudit({
      dir,
      scanner: osvScanner({ runner }),
      fixers: options.fix
        ? [
            osvFixer({ runner, ...(options.upgrade ? { upgrade: options.upgrade } : {}) }),
            jsFixer({ runner }),
            goFixer({ runner }),
          ]
        : [],
      allowlist: options.allowlist,
      traits: options.traits,
      ...(signal ? { signal } : {}),
    })
    return { data, ...(ref ? { ref } : {}) }
  },
})
