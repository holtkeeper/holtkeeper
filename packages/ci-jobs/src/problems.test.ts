import { describe, expect, test } from 'bun:test'

import { at, attempt, quarter } from '../test/history.ts'
import { analyzeCiJobs } from './analyze.ts'
import { jobProblems, problemJobs } from './problems.ts'
import type { CiJobsData, CiJobsOptions } from './types.ts'

const options: CiJobsOptions = { days: 90, recentDays: 14, changePercent: 20, minChangeSeconds: 15 }

const analyzed = (records = quarter()): CiJobsData => ({
  ...analyzeCiJobs(records, { from: at(0), to: at(90), defaultBranch: 'main' }, options),
  history: { jobs: records.length },
})

/** A job that passes on retry in `flaky` of 10 pipelines. */
const flakyJob = (name: string, flaky: number) =>
  Array.from({ length: 10 }, (_, day) => {
    const pipelineId = 100 * name.length + day
    const created = at(day * 8)
    return day < flaky
      ? [
          attempt(name, created, 20, { pipelineId, status: 'failed' }),
          attempt(name, created, 20, { pipelineId }),
        ]
      : [attempt(name, created, 20, { pipelineId })]
  }).flat()

describe('problemJobs', () => {
  test('names failing and slower jobs with a one-line reason and a link', () => {
    const data = analyzed()
    const problems = problemJobs(data)
    expect(problems).toEqual([
      {
        job: 'test',
        stage: 'test',
        kind: 'failing',
        reason: 'fails in 10% of runs',
        href: expect.stringContaining('/-/jobs/'),
      },
      {
        job: 'build',
        stage: 'build',
        kind: 'slower',
        reason: '+60% since 14 Sep (1m 40s → 2m 40s)',
        href: data.jobs.find((j) => j.name === 'build')?.changePoint?.href ?? '',
      },
    ])
  })

  test('flaky needs two pipelines passing only on retry', () => {
    const data = analyzed([...flakyJob('once', 1), ...flakyJob('often', 3)])
    expect(problemJobs(data)).toEqual([
      expect.objectContaining({
        job: 'often',
        kind: 'flaky',
        reason: 'passed only on retry in 3 pipelines, retried in 30% of them',
      }),
    ])
    const often = data.jobs.find((j) => j.name === 'often')
    expect(often && jobProblems(often)).toEqual(['flaky'])
  })

  test('takes kinds in turn and stops at the limit', () => {
    const records = [
      ...quarter(),
      ...flakyJob('aa', 2),
      ...flakyJob('bbb', 4),
      ...flakyJob('cccc', 3),
    ]
    const kinds = problemJobs(analyzed(records), 4).map((p) => [p.kind, p.job])
    expect(kinds).toEqual([
      ['failing', 'test'],
      ['slower', 'build'],
      ['flaky', 'bbb'],
      ['flaky', 'cccc'],
    ])
  })

  test('jobs allowed to fail are never failing', () => {
    const lint = analyzed().jobs.find((j) => j.name === 'lint')
    expect(lint && jobProblems(lint)).toEqual([])
  })
})
