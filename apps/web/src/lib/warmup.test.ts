import { describe, expect, test } from 'bun:test'

import type { AnalysisSummary, JobSummary } from '@holtkeeper/api'

import { warmupRuns } from './warmup.ts'

const job = (patch: Partial<JobSummary>): JobSummary => ({
  id: 'j',
  analyzer: 'warmup',
  repo: { forge: 'work', path: 'games/libs' },
  options: {},
  trigger: 'push',
  status: 'succeeded',
  attempts: 1,
  maxAttempts: 3,
  runAfter: '2026-10-31T10:00:00Z',
  createdAt: '2026-10-31T10:00:00Z',
  ...patch,
})

describe('warmupRuns', () => {
  test('takes the outcome from the record and the branch from the job until there is one', () => {
    const record: AnalysisSummary = {
      id: 'a1',
      repo: { forge: 'work', path: 'games/libs' },
      kind: 'warmup',
      label: 'Build warm-up',
      createdAt: '2026-10-31T10:05:00Z',
      metrics: [
        { id: 'status', label: 'Status', value: 'failed', unit: 'text' },
        { id: 'duration', label: 'Duration', value: 90_000, unit: 'ms' },
        { id: 'branch', label: 'Branch', value: 'main', unit: 'text' },
      ],
    }
    const runs = warmupRuns(
      [
        job({ id: 'running', status: 'running', options: { branch: 'release/1' } }),
        job({ id: 'done', analysisId: 'a1', options: { branch: 'main' } }),
      ],
      [record],
    )
    expect(runs.map(({ job: j, analysis, build }) => [j.id, analysis?.id, build])).toEqual([
      ['running', undefined, { branch: 'release/1' }],
      ['done', 'a1', { status: 'failed', durationMs: 90_000, branch: 'main' }],
    ])
  })
})
