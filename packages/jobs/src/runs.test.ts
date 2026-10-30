import { describe, expect, test } from 'bun:test'

import type { Job } from '@holtkeeper/store'

import { scheduleRuns } from './runs.ts'

let id = 0
const job = (createdAt: string, overrides: Partial<Job> = {}): Job => ({
  id: String(++id),
  analyzer: 'ci-jobs',
  repo: { forge: 'work', path: `g/${id}` },
  options: {},
  trigger: 'schedule',
  status: 'succeeded',
  attempts: 1,
  maxAttempts: 3,
  runAfter: createdAt,
  createdAt,
  log: [],
  schedule: 'nightly',
  ...overrides,
})

describe('scheduleRuns', () => {
  test('groups jobs queued together, newest run first, and sums statuses', () => {
    const runs = scheduleRuns([
      job('2026-10-01T03:00:00.000Z', {
        startedAt: '2026-10-01T03:01:00.000Z',
        finishedAt: '2026-10-01T03:05:00.000Z',
      }),
      job('2026-10-01T03:00:00.000Z', {
        status: 'failed',
        error: 'boom',
        analyzer: 'delivery',
        startedAt: '2026-10-01T03:00:30.000Z',
        finishedAt: '2026-10-01T03:02:00.000Z',
      }),
      job('2026-10-02T03:00:00.000Z', { status: 'running', actor: 'jane' }),
      job('2026-10-02T03:00:00.000Z', { status: 'queued' }),
    ])
    expect(runs.map((r) => r.at)).toEqual(['2026-10-02T03:00:00.000Z', '2026-10-01T03:00:00.000Z'])
    expect(runs[0]).toMatchObject({ actor: 'jane', jobs: 2, running: 1, queued: 1, failures: [] })
    expect(runs[0]?.finishedAt).toBeUndefined()
    expect(runs[1]).toMatchObject({
      jobs: 2,
      succeeded: 1,
      failed: 1,
      analyzers: ['ci-jobs', 'delivery'],
      startedAt: '2026-10-01T03:00:30.000Z',
      finishedAt: '2026-10-01T03:05:00.000Z',
      failures: [{ analyzer: 'delivery', error: 'boom' }],
    })
  })

  test('keeps the newest runs up to the limit', () => {
    const jobs = ['01', '02', '03'].map((day) => job(`2026-10-${day}T03:00:00.000Z`))
    expect(scheduleRuns(jobs, 2).map((r) => r.at.slice(8, 10))).toEqual(['03', '02'])
  })
})
