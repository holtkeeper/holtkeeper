import { describe, expect, test } from 'bun:test'

import { at, attempt, quarter } from '../test/history.ts'
import { analyzeCiJobs } from './analyze.ts'
import { ciJobTable } from './jobs.ts'
import type { CiJobsData, CiJobsOptions } from './types.ts'

const options: CiJobsOptions = { days: 90, recentDays: 14, changePercent: 20, minChangeSeconds: 15 }

const analyzed = (records = quarter()): CiJobsData => ({
  ...analyzeCiJobs(records, { from: at(0), to: at(90), defaultBranch: 'main' }, options),
  history: { jobs: records.length },
})

describe('ciJobTable', () => {
  test('problem jobs come first, then the slowest; totals cover every job', () => {
    const data = analyzed()
    const table = ciJobTable(data, 10)
    expect(table.total).toBe(data.jobs.length)
    expect(table.rows.map((row) => row.name)).toEqual(['test', 'build', 'deploy', 'lint'])
    expect(table.rows[0]).toMatchObject({ problems: ['failing'], failureRate: 10 })
    expect(table.rows[1]?.problems).toEqual(['slower'])
    const sum = data.jobs.reduce((total, job) => total + (job.outcomes?.success ?? 0), 0)
    expect(table.outcomes.success).toBe(sum)
  })

  test('caps the rows but not the totals', () => {
    const data = analyzed()
    const table = ciJobTable(data, 1)
    expect(table.rows).toHaveLength(1)
    expect(table.total).toBe(4)
    expect(table.outcomes.failed).toBeGreaterThan(table.rows[0]?.outcomes.failed ?? 0)
    expect(ciJobTable(data, 0).rows).toEqual([])
  })

  test('jobs of records written before outcomes report zeros', () => {
    const data = analyzed([attempt('build', at(1), 10)])
    const jobs = data.jobs.map((job) => {
      const copy = { ...job }
      delete copy.outcomes
      return copy
    })
    const old = { ...data, jobs }
    const table = ciJobTable(old, 5)
    expect(table.rows[0]?.outcomes).toEqual({ success: 0, failed: 0, canceled: 0 })
    expect(table.outcomes).toEqual({ success: 0, failed: 0, canceled: 0 })
  })
})
