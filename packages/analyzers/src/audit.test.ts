import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFakeRunner } from '@holtkeeper/exec/testing'
import type { AuditReport } from '@holtkeeper/vuln'

import { auditAnalysis, auditAnalyzer, auditFindingKey, auditMetrics } from './audit.ts'

const finding = {
  id: 'GHSA-1',
  aliases: [],
  summary: 'bad',
  severity: 'high' as const,
  url: 'https://osv.dev/GHSA-1',
  package: { name: 'left-pad', version: '1.0.0', ecosystem: 'npm' },
  source: 'package-lock.json',
  fixedVersions: ['1.0.1'],
}

const report: AuditReport = {
  scanner: 'osv-scanner',
  findings: [finding],
  ignored: [],
  expired: [],
  fixes: [],
  resolved: [],
  changedFiles: [],
}

test('summarizes and renders an audit report', () => {
  expect(auditAnalysis.summarize(report)).toEqual([
    {
      id: 'active',
      label: 'Vulnerable',
      value: 1,
      unit: 'count',
      better: 'down',
      tone: 'bad',
    },
    { id: 'ignored', label: 'Allowlisted', value: 0, unit: 'count' },
  ])
  const rendered = auditAnalysis.toReport({
    id: 'a1',
    repo: { forge: 'work', path: 'games/a' },
    kind: 'audit',
    createdAt: '2026-10-30T12:00:00.000Z',
    data: report,
  })
  const table = rendered.sections[1]?.blocks[0]
  expect(table?.type === 'table' ? table.rows[0] : undefined).toMatchObject({
    package: 'left-pad@1.0.0',
    fix: '1.0.1',
    severity: { text: 'high', tone: 'bad' },
  })
  expect(auditAnalysis.schema.safeParse(report).success).toBeTrue()
})

test('scans the checkout with osv-scanner through the job runner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'holtkeeper-audit-'))
  try {
    const { runner, calls } = createFakeRunner(() => ({ stdout: '{"results":[]}' }))
    const result = await auditAnalyzer.run({
      repo: { forge: 'work', path: 'games/a' },
      dir,
      runner,
      ref: 'v1',
      options: auditAnalyzer.options.parse({}),
      log: () => {},
    })
    expect(result.ref).toBe('v1')
    expect(result.data.findings).toEqual([])
    expect(calls[0]?.command.slice(0, 3)).toEqual(['osv-scanner', 'scan', 'source'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('metrics count active advisories per severity', () => {
  const metrics = auditMetrics({
    ...report,
    findings: [
      finding,
      { ...finding, id: 'GHSA-2', severity: 'critical' },
      { ...finding, id: 'GHSA-3' },
    ],
    ignored: [
      { finding, entry: { id: 'GHSA-1', reason: 'not reachable' } },
    ] as AuditReport['ignored'],
  })
  expect(metrics).toMatchObject({
    findings: 3,
    severities: { critical: 1, high: 2, medium: 0, low: 0, unknown: 0 },
    ignored: 1,
    expired: 0,
    resolved: 0,
    firstSeen: {},
  })
  expect(metrics.advisories).toHaveLength(4)
})

test('metrics keep every finding for fleet tables, allowlisted ones with their expiry', () => {
  const metrics = auditMetrics({
    ...report,
    ignored: [
      {
        finding: { ...finding, id: 'GHSA-9' },
        entry: { id: 'GHSA-9', reason: 'dev only', expires: '2026-12-01' },
      },
      { finding: { ...finding, id: 'GHSA-8' }, entry: { id: 'GHSA-8', reason: 'not shipped' } },
    ],
  })
  expect(metrics.advisories).toEqual([
    {
      id: 'GHSA-1',
      aliases: [],
      summary: 'bad',
      url: 'https://osv.dev/GHSA-1',
      severity: 'high',
      package: 'left-pad',
      ecosystem: 'npm',
      version: '1.0.0',
      source: 'package-lock.json',
      fixedIn: ['1.0.1'],
    },
    expect.objectContaining({ id: 'GHSA-9', allowlisted: { until: '2026-12-01' } }),
    expect.objectContaining({ id: 'GHSA-8', allowlisted: {} }),
  ])
})

test('first-seen times carry over from the previous record and start at the record time', () => {
  const first = auditMetrics(report, { createdAt: '2026-11-01T00:00:00.000Z' })
  expect(first.firstSeen).toEqual({
    [auditFindingKey({ id: 'GHSA-1', ecosystem: 'npm', package: 'left-pad' })]:
      '2026-11-01T00:00:00.000Z',
  })

  const second = auditMetrics(
    {
      ...report,
      findings: [
        { ...finding, package: { ...finding.package, version: '1.0.0-patched' } },
        { ...finding, id: 'GHSA-2' },
      ],
    },
    { previous: first, createdAt: '2026-11-05T00:00:00.000Z' },
  )
  expect(second.firstSeen).toEqual({
    'GHSA-1|npm|left-pad': '2026-11-01T00:00:00.000Z',
    'GHSA-2|npm|left-pad': '2026-11-05T00:00:00.000Z',
  })

  const gone = auditMetrics(
    { ...report, findings: [] },
    { previous: second, createdAt: '2026-11-06T00:00:00.000Z' },
  )
  expect(gone.firstSeen).toEqual({})
})

test('first-seen times are left out when the record time is unknown', () => {
  const legacy = { ...auditMetrics(report), firstSeen: undefined } as never
  expect(auditMetrics(report, { previous: legacy }).firstSeen).toEqual({})
})
