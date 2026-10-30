import { defineAnalyzer } from '@holtkeeper/analyzer'
import { type Metric, type Report, defineAnalysis } from '@holtkeeper/report'
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

/** Vulnerability audits run as background jobs; the server also stores each one as an audit run. */
export const auditAnalysis = defineAnalysis<AuditReport>({
  kind: 'audit',
  label: 'Vulnerability audit',
  schema: auditReportSchema,
  summarize: summarizeAudit,
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
  needs: { checkout: true },
  options: z.object({
    fix: z.boolean().default(false),
    allowlist: allowlistSchema.default([]),
    traits: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  }),
  async run({ dir, ref, runner, options, signal }) {
    if (!dir) throw new Error('this analyzer needs a checkout')
    const data = await runAudit({
      dir,
      scanner: osvScanner({ runner }),
      fixers: options.fix ? [osvFixer({ runner }), jsFixer({ runner }), goFixer({ runner })] : [],
      allowlist: options.allowlist,
      traits: options.traits,
      ...(signal ? { signal } : {}),
    })
    return { data, ...(ref ? { ref } : {}) }
  },
})
