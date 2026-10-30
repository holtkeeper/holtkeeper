import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFakeRunner } from '@holtkeeper/exec/testing'
import type { AuditReport } from '@holtkeeper/vuln'

import { auditAnalysis, auditAnalyzer } from './audit.ts'

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
