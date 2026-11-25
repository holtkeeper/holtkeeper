import { describe, expect, test } from 'bun:test'

import type { AnalysisRecord } from '@holtkeeper/store'

import { upgradeCheckAnalysis } from './analysis.ts'
import type { UpgradeCheckData } from './schema.ts'

const data: UpgradeCheckData = {
  from: { ref: 'v1.0.0', sha: 'a'.repeat(40), label: 'v1.0.0' },
  to: { ref: 'v2.0.0', sha: 'b'.repeat(40) },
  verdict: 'breaking',
  summary: 'The widget table loses a column.',
  areas: [{ name: 'Widgets', files: 4, summary: 'Adds a migration.' }],
  findings: [
    {
      id: 'f1',
      severity: 'breaking',
      category: 'data',
      title: 'Drops the legacy column',
      detail: 'Old rows lose data.',
      files: [{ path: 'db/migrate.sql', line: 3 }],
      affects: 'Stored widgets',
      check: 'Back up the table.',
    },
    {
      id: 'f2',
      severity: 'info',
      category: 'other',
      title: 'Renames a helper',
      detail: 'Internal.',
      files: [],
      check: 'Nothing to do.',
    },
  ],
  skipped: [{ files: 2, reason: 'binary files' }],
  capped: false,
  usage: { turns: 12, costUsd: 1.25 },
}

const record = (value: UpgradeCheckData): AnalysisRecord<UpgradeCheckData> => ({
  id: 'r1',
  repo: { forge: 'gitlab', path: 'shop/widgets' },
  kind: 'upgrade-check',
  createdAt: '2026-11-01T00:00:00.000Z',
  data: value,
})

describe('upgradeCheckAnalysis', () => {
  test('validates data and rejects unknown verdicts', () => {
    expect(upgradeCheckAnalysis.schema.safeParse(data).success).toBe(true)
    expect(upgradeCheckAnalysis.schema.safeParse({ ...data, verdict: 'fine' }).success).toBe(false)
  })

  test('summarizes verdict, counts and cost', () => {
    const metrics = upgradeCheckAnalysis.summarize(data)
    expect(metrics.map((m) => [m.id, m.value])).toEqual([
      ['verdict', 'breaking'],
      ['breaking', 1],
      ['risky', 0],
      ['files', 4],
      ['areas', 1],
      ['cost', '$1.25'],
    ])
  })

  test('reports findings grouped by severity and what was not checked', () => {
    const report = upgradeCheckAnalysis.toReport(record(data))
    expect(report.title).toBe('Breaking-change check v1.0.0 → v2.0.0')
    const findings = report.sections.find((section) => section.id === 'findings')
    expect(
      findings?.blocks.map((block) => (block.type === 'issues' ? block.title : block.type)),
    ).toEqual(['Breaking', 'Worth knowing'])
    const first = findings?.blocks[0]
    expect(first?.type === 'issues' && first.items[0]?.detail).toContain('`db/migrate.sql:3`')
    const skipped = report.sections.find((section) => section.id === 'not-checked')
    expect(skipped?.blocks[0]?.type).toBe('table')
  })
})
