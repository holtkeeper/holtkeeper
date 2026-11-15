import { describe, expect, test } from 'bun:test'

import type { EvalCase } from './case.ts'
import { type CaseResult, type ScoredInput, scoreCase, summarize } from './score.ts'

const testCase: EvalCase = {
  id: 'widget-sizes',
  title: 'Widget sizes',
  merge: { title: 'Resize widgets', description: '' },
  changes: {},
  expected: [
    {
      id: 'off-by-one',
      path: 'src/widget.ts',
      lines: [10, 12],
      note: 'loop skips the last widget',
      mentions: [['last'], ['off-by-one']],
      minSeverity: 'major',
    },
    {
      id: 'unchecked',
      path: 'src/widget.ts',
      lines: [30, 30],
      note: 'size is not validated',
      categories: ['bug', 'security'],
    },
  ],
}

const comment = (extra: Partial<ScoredInput>): ScoredInput => ({
  path: 'src/widget.ts',
  line: 11,
  severity: 'major',
  category: 'bug',
  title: 'Loop skips the last item',
  body: 'The condition stops one early.',
  ...extra,
})

describe('scoreCase', () => {
  test('matches a comment to the problem on its lines and mentions', () => {
    const score = scoreCase(testCase, [comment({})])
    expect(score.found).toEqual(['off-by-one'])
    expect(score.missed).toEqual(['unchecked'])
    expect(score.falsePositives).toBe(0)
    expect(score.comments[0]?.matched).toBe('off-by-one')
  })

  test('allows a little slack around the lines but not more', () => {
    expect(scoreCase(testCase, [comment({ line: 14 })]).found).toEqual(['off-by-one'])
    expect(scoreCase(testCase, [comment({ line: 15 })]).found).toEqual([])
  })

  test('counts a range comment that reaches into the lines', () => {
    expect(scoreCase(testCase, [comment({ line: 20, startLine: 12 })]).found).toEqual([
      'off-by-one',
    ])
  })

  test('needs the right file, the words and an accepted category', () => {
    expect(scoreCase(testCase, [comment({ path: 'src/other.ts' })]).found).toEqual([])
    expect(scoreCase(testCase, [comment({ title: 'Naming', body: 'Rename it.' })]).found).toEqual(
      [],
    )
    expect(scoreCase(testCase, [comment({ title: 'An OFF-BY-ONE', body: 'x' })]).found).toEqual([
      'off-by-one',
    ])
    expect(scoreCase(testCase, [comment({ line: 30, category: 'style' })]).found).toEqual([])
    expect(scoreCase(testCase, [comment({ line: 30, category: 'security' })]).found).toEqual([
      'unchecked',
    ])
  })

  test('treats a second comment on a found problem as a duplicate, not a false positive', () => {
    const score = scoreCase(testCase, [comment({}), comment({ line: 12 })])
    expect(score.duplicates).toBe(1)
    expect(score.falsePositives).toBe(0)
    expect(score.comments[1]).toMatchObject({ matched: 'off-by-one', duplicate: true })
  })

  test('counts comments on nothing expected as false positives', () => {
    const score = scoreCase(testCase, [comment({ line: 50 }), comment({ path: 'src/x.ts' })])
    expect(score.falsePositives).toBe(2)
    expect(score.found).toEqual([])
  })

  test('flags a found problem rated below the expected severity, by its best comment', () => {
    expect(scoreCase(testCase, [comment({ severity: 'minor' })]).underrated).toEqual(['off-by-one'])
    expect(
      scoreCase(testCase, [comment({ severity: 'minor' }), comment({ severity: 'critical' })])
        .underrated,
    ).toEqual([])
  })

  test('a clean case with comments only has false positives', () => {
    const clean: EvalCase = { ...testCase, expected: [] }
    expect(scoreCase(clean, [comment({})])).toMatchObject({ falsePositives: 1, found: [] })
  })
})

const result = (caseId: string, expected: number, comments: ScoredInput[], extra = {}) => {
  const target: EvalCase = {
    ...testCase,
    id: caseId,
    expected: testCase.expected.slice(0, expected),
  }
  return {
    caseId,
    run: 1,
    score: scoreCase(target, comments),
    expected,
    usage: { turns: 3, costUsd: 0.5 },
    durationMs: 1000,
    ...extra,
  } satisfies CaseResult
}

describe('summarize', () => {
  test('computes precision and recall over all runs together', () => {
    const summary = summarize([
      result('a', 2, [comment({}), comment({ line: 50 })]),
      result('b', 1, [comment({})]),
    ])
    expect(summary).toMatchObject({
      runs: 2,
      expected: 3,
      found: 2,
      comments: 3,
      matched: 2,
      falsePositives: 1,
      costUsd: 1,
      turns: 6,
      durationMs: 2000,
    })
    expect(summary.precision).toBeCloseTo(2 / 3)
    expect(summary.recall).toBeCloseTo(2 / 3)
    expect(summary.f1).toBeCloseTo(2 / 3)
  })

  test('counts clean runs and the ones that still drew a comment', () => {
    const summary = summarize([
      result('clean-1', 0, []),
      result('clean-2', 0, [comment({})]),
      result('bad', 1, [], { error: 'boom' }),
    ])
    expect(summary).toMatchObject({ cleanRuns: 2, cleanFlagged: 1, errors: 1 })
  })

  test('is perfect when nothing is expected and nothing is said', () => {
    expect(summarize([result('clean', 0, [])])).toMatchObject({ precision: 1, recall: 1, f1: 1 })
  })

  test('has a zero f1 when nothing matches', () => {
    expect(summarize([result('a', 1, [comment({ line: 50 })])]).f1).toBe(0)
  })
})
