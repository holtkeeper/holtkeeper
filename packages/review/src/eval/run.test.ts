import { describe, expect, test } from 'bun:test'

import { createFakeRunner } from '@holtkeeper/exec/testing'

import { fakeAgent } from '../../test/fakes.ts'
import { goldenCases } from './cases/index.ts'
import { diffOf, filesAfter, runCase, runEval } from './run.ts'
import { summarize } from './score.ts'

const byId = (id: string) => {
  const found = goldenCases.find((testCase) => testCase.id === id)
  if (!found) throw new Error(`no case ${id}`)
  return found
}

const comment = (path: string, line: number, extra = {}) => ({
  path,
  line,
  severity: 'major' as const,
  category: 'bug' as const,
  title: 'Problem',
  body: 'Something is wrong here.',
  ...extra,
})

const review = (comments: ReturnType<typeof comment>[]) => ({
  comments,
  summary: 'Reviewed.',
  verdict: comments.length ? ('needs-changes' as const) : ('looks-good' as const),
})

describe('diffOf and filesAfter', () => {
  test('describe a case as a merge request would', () => {
    const testCase = byId('signature-callers')
    expect(diffOf(testCase).map((file) => [file.newPath, file.status])).toEqual([
      ['src/money.ts', 'modified'],
    ])
    expect(Object.keys(filesAfter(testCase)).toSorted()).toEqual(['src/money.ts', 'src/report.ts'])
    expect(filesAfter(testCase)['src/money.ts']).toContain('currency')
  })

  test('puts the case guide where the review reads its rules', () => {
    const files = filesAfter({ ...byId('clean-readme'), guide: 'Be brief.' })
    expect(files['REVIEW.md']).toBe('Be brief.')
  })
})

describe('runCase', () => {
  test('scores the comments the review posts', async () => {
    const testCase = byId('page-skips-first')
    const [from] = testCase.expected[0]?.lines ?? [0, 0]
    const { agent } = fakeAgent({ review: [review([comment('src/page.ts', from)])] })
    const result = await runCase(testCase, { agent, runner: createFakeRunner().runner })
    expect(result.error).toBeUndefined()
    expect(result.score.found).toEqual(['start-offset'])
    expect(result.score.falsePositives).toBe(0)
    expect(result.verdict).toBe('needs-changes')
    expect(result.usage?.turns).toBeGreaterThan(0)
  })

  test('counts a comment on something else as a false positive and a silent review as missed', async () => {
    const testCase = byId('page-skips-first')
    const noisy = fakeAgent({ review: [review([comment('src/page.ts', 1)])] })
    const first = await runCase(testCase, { agent: noisy.agent, runner: createFakeRunner().runner })
    expect(first.score).toMatchObject({ found: [], falsePositives: 1, missed: ['start-offset'] })

    const silent = fakeAgent({ review: [review([])] })
    const second = await runCase(testCase, {
      agent: silent.agent,
      runner: createFakeRunner().runner,
    })
    expect(second.score.missed).toEqual(['start-offset'])
  })

  test('hands the agent the checkout with the case files and the guide', async () => {
    const testCase = { ...byId('clean-readme'), changes: byId('clean-fix-with-test').changes }
    const { agent, tasks } = fakeAgent({ review: [review([])] })
    await runCase(
      { ...testCase, guide: 'Prefer short comments.' },
      { agent, runner: createFakeRunner().runner },
    )
    const task = tasks.find((candidate) => candidate.taskKind === 'review')
    expect(task?.dir).toContain('holtkeeper-eval-')
    expect(JSON.stringify(task)).toContain('Prefer short comments.')
  })

  test('a review that throws is a failed run with everything missed', async () => {
    const testCase = byId('page-skips-first')
    const result = await runCase(testCase, {
      agent: {
        name: 'broken',
        run: async () => {
          throw new Error('provider down')
        },
      },
      runner: createFakeRunner().runner,
    })
    expect(result.error).toContain('provider down')
    expect(result.score.missed).toEqual(['start-offset'])
  })
})

describe('runEval', () => {
  test('repeats every case and sums up', async () => {
    const cases = [byId('page-skips-first'), byId('clean-readme')]
    const { agent } = fakeAgent({ review: Array.from({ length: 4 }, () => review([])) })
    const seen: string[] = []
    const results = await runEval({
      cases,
      repeat: 2,
      concurrency: 2,
      agent,
      runner: createFakeRunner().runner,
      onResult: (result) => seen.push(`${result.caseId}#${result.run}`),
    })
    expect(results.map((result) => `${result.caseId}#${result.run}`)).toEqual([
      'page-skips-first#1',
      'page-skips-first#2',
      'clean-readme#1',
      'clean-readme#2',
    ])
    expect(seen.length).toBe(4)
    expect(summarize(results)).toMatchObject({ runs: 4, expected: 2, found: 0, recall: 0 })
  })
})
