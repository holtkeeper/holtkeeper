import { describe, expect, test } from 'bun:test'

import { qualityAnalysis } from './report.ts'
import type { QualityData } from './types.ts'

const record = (data: Partial<QualityData>) => ({
  id: 'a',
  repo: { forge: 'gitlab', path: 'group/app' },
  kind: 'quality',
  createdAt: '2026-10-31T00:00:00.000Z',
  data: { tools: [], issues: [], tests: [], conventions: [], changes: [], ...data },
})

const report = (data: Partial<QualityData>) => qualityAnalysis.toReport(record(data))

describe('qualityAnalysis', () => {
  test('a skipped tool is not shown as ok', () => {
    const tools = report({
      tools: [{ name: 'lint', ok: true, skipped: 'eslint not installed', durationMs: 9 }],
    }).sections.find((section) => section.id === 'tools')
    expect(JSON.stringify(tools)).toContain(
      '"text":"skipped: eslint not installed","tone":"warning"',
    )
  })

  test('places worth testing only appear when the tests check ran', () => {
    const skipped = report({ tools: [{ name: 'lint', ok: true }] })
    expect(skipped.metrics.map((m) => m.id)).not.toContain('untested')
    expect(skipped.subtitle).toBe('0 issues, 0 suggested changes')
    const ran = report({ tools: [{ name: 'tests', ok: true }] })
    expect(ran.metrics.map((m) => m.id)).toContain('untested')
  })

  test('naming consistency counts only established conventions', () => {
    const conventions = [
      {
        language: 'ts',
        kind: 'type',
        dominant: 'PascalCase',
        share: 0.9,
        total: 100,
        outliers: 10,
      },
      {
        language: 'ts',
        kind: 'module variable',
        dominant: 'PascalCase',
        share: 0.4,
        total: 100,
        outliers: 60,
        established: false,
      },
    ]
    const result = report({ conventions })
    expect(result.metrics.find((m) => m.id === 'naming')?.value).toBe(90)
    expect(JSON.stringify(result.sections[0])).toContain('none (mostly PascalCase)')
  })
})
