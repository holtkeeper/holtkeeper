import { describe, expect, test } from 'bun:test'

import { memoryStore } from '@holtkeeper/store/memory'

import { at, fakeForge, quarter, repo, toJobRuns } from '../test/history.ts'
import { ciJobsOptionsSchema, createCiJobsAnalyzer } from './analyzer.ts'
import { ciJobsDataSchema } from './schema.ts'

const runner = { run: () => Promise.reject(new Error('the ci-jobs analyzer runs no commands')) }

describe('ci-jobs analyzer', () => {
  test('declares scope, needs and defaults', () => {
    const analyzer = createCiJobsAnalyzer()
    expect(analyzer).toMatchObject({
      kind: 'ci-jobs',
      scope: 'repo',
      needs: { forge: true, history: true },
      keepRecords: 3,
    })
    expect(ciJobsOptionsSchema.parse({ days: '30' })).toEqual({
      days: 30,
      recentDays: 14,
      changePercent: 20,
      minChangeSeconds: 15,
      maxJobs: 50_000,
    })
  })

  test('keeps history in the store and reads only what is new on the next run', async () => {
    const store = memoryStore()
    const jobs = toJobRuns(quarter())
    const forge = fakeForge(() => jobs)
    const history = { analyses: store.analyses, auditRuns: store.auditRuns, ciJobs: store.ciJobs }
    const analyzer = createCiJobsAnalyzer({ now: () => new Date(at(90)) })
    const options = ciJobsOptionsSchema.parse({ branch: 'main' })

    const first = await analyzer.run({ repo, forge, runner, history, options })
    expect(ciJobsDataSchema.parse(first.data)).toEqual(first.data)
    expect(first.data.history).toMatchObject({ jobs: 304, syncedFrom: at(0) })
    expect(first.data.jobs.filter((j) => j.trend === 'slower').map((j) => j.name)).toEqual([
      'build',
    ])
    await store.analyses.add({
      repo,
      kind: 'ci-jobs',
      createdAt: at(90),
      data: first.data,
    })

    const second = await analyzer.run({ repo, forge, runner, history, options })
    expect(forge.calls).toEqual([`jobs after ${at(0)}`, `jobs after ${at(88, 14)}`])
    expect(second.data.pipelines).toEqual(first.data.pipelines)
  })

  test('without a store it reads everything and logs that history is not kept', async () => {
    const analyzer = createCiJobsAnalyzer({ now: () => new Date(at(90)) })
    const lines: string[] = []
    const { data } = await analyzer.run({
      repo,
      forge: fakeForge(() => toJobRuns(quarter())),
      runner,
      options: ciJobsOptionsSchema.parse({}),
      log: (line) => lines.push(line),
    })
    expect(data.pipelines).toMatchObject({ ref: 'main', count: 90 })
    expect(lines.some((line) => line.includes('history is not kept'))).toBe(true)
  })

  test('an earlier record in an older shape still lets the next sync be incremental', async () => {
    const store = memoryStore()
    const jobs = toJobRuns(quarter())
    const forge = fakeForge(() => jobs)
    const history = { analyses: store.analyses, auditRuns: store.auditRuns, ciJobs: store.ciJobs }
    const analyzer = createCiJobsAnalyzer({ now: () => new Date(at(90)) })
    const options = ciJobsOptionsSchema.parse({})
    await analyzer.run({ repo, forge, runner, history, options })
    await store.analyses.add({
      repo,
      kind: 'ci-jobs',
      createdAt: at(90),
      data: { history: { jobs: 304, syncedFrom: at(0) }, totals: {}, notes: [] },
    })
    await analyzer.run({ repo, forge, runner, history, options })
    expect(forge.calls.at(-1)).toBe(`jobs after ${at(88, 14)}`)
  })
})
