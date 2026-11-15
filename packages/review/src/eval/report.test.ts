import { describe, expect, test } from 'bun:test'

import { qualityRows } from '../quality.ts'
import type { EvalCase } from './case.ts'
import { formatEval, formatQuality } from './report.ts'
import { type CaseResult, scoreCase } from './score.ts'

const testCase: EvalCase = {
  id: 'widget-sizes',
  title: 'Widget sizes',
  merge: { title: 'Resize', description: '' },
  changes: {},
  expected: [
    { id: 'off-by-one', path: 'a.ts', lines: [10, 10], note: 'x', minSeverity: 'major' },
    { id: 'unchecked', path: 'a.ts', lines: [30, 30], note: 'y' },
  ],
}

const comment = (line: number, severity: 'minor' | 'major' = 'major') => ({
  path: 'a.ts',
  line,
  severity,
  category: 'bug' as const,
  title: `Problem at ${line}`,
  body: '',
})

describe('formatEval', () => {
  test('leads with the numbers and lists what to look at', () => {
    const results: CaseResult[] = [
      {
        caseId: 'widget-sizes',
        run: 1,
        expected: 2,
        score: scoreCase(testCase, [comment(10, 'minor'), comment(99)]),
        usage: { turns: 4, costUsd: 0.25 },
        durationMs: 5000,
      },
      {
        caseId: 'broken',
        run: 2,
        expected: 2,
        score: scoreCase({ ...testCase, id: 'broken' }, []),
        error: 'provider down',
      },
    ]
    const report = formatEval(results)
    expect(report.split('\n')[0]).toBe('precision 50%   recall 25%   f1 33%')
    expect(report).toContain('problems found 1/4, underrated 1')
    expect(report).toContain('1 FAILED')
    expect(report).toContain('$0.25')
    expect(report).toContain('Failed runs:\n  broken#2: provider down')
    expect(report).toContain('Missed:\n  widget-sizes: unchecked')
    expect(report).toContain('Underrated:\n  widget-sizes: off-by-one')
    expect(report).toContain('widget-sizes: a.ts:99 [major/bug] Problem at 99')
  })

  test('has no sections when nothing is wrong', () => {
    const clean = { ...testCase, expected: [] }
    const report = formatEval([
      { caseId: 'clean', run: 1, expected: 0, score: scoreCase(clean, []) },
    ])
    expect(report).not.toContain(':\n')
    expect(report).toContain('precision 100%   recall 100%')
  })
})

describe('formatQuality', () => {
  test('prints a row per group and the total', () => {
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- helper sits with its test
    const signal = (category: string, outcome: 'fixed' | 'ignored') => ({
      repo: 'work:a',
      mergeRequest: 1,
      noteId: `${category}${outcome}${Math.random()}`,
      category,
      up: 0,
      down: 0,
      updatedAt: '2025-01-01T00:00:00.000Z',
      outcome,
      mergeRequestState: 'merged' as const,
    })
    const { rows, total } = qualityRows(
      [signal('bug', 'fixed'), signal('bug', 'ignored'), signal('style', 'ignored')],
      'category',
    )
    const lines = formatQuality('category', rows, total).split('\n')
    expect(lines[0]).toMatch(/^category\s+comments\s+fixed/)
    expect(lines[1]).toMatch(/^bug\s+2\s+1\s+0\s+1\s+0\s+50%\s+50%$/)
    expect(lines[2]).toMatch(/^style\s+1\s+0\s+0\s+1\s+0\s+0%\s+0%$/)
    expect(lines[3]).toMatch(/^all\s+3\s+1\s+0\s+2\s+0\s+33%\s+33%$/)
  })
})
