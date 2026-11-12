import { describe, expect, test } from 'bun:test'

import type { JobStep } from '@holtkeeper/api'

import { jobProgress } from './progress.ts'

const step = (name: string, status: JobStep['status'], depth = 0): JobStep => ({
  name,
  status,
  depth,
  line: 1,
  startedAt: '2026-01-01T00:00:00Z',
})

describe('jobProgress', () => {
  test('is undefined without top-level steps', () => {
    expect(jobProgress([])).toBeUndefined()
    expect(jobProgress([step('inner', 'running', 1)])).toBeUndefined()
  })

  test('names the running step and its position', () => {
    const progress = jobProgress([
      step('checkout', 'succeeded'),
      step('install', 'succeeded'),
      step('fetch', 'running', 1),
      step('scan', 'running'),
    ])
    expect(progress?.label).toBe('Step 3 of 3 · scan')
    expect(progress?.segments.map((segment) => segment.tone)).toEqual([
      'success',
      'success',
      'info',
    ])
  })

  test('names the failed step', () => {
    expect(jobProgress([step('checkout', 'succeeded'), step('scan', 'failed')])?.label).toBe(
      'Failed in scan',
    )
  })

  test('counts the steps of a finished attempt', () => {
    expect(jobProgress([step('checkout', 'succeeded')])?.label).toBe('1 step')
    expect(jobProgress([step('checkout', 'succeeded'), step('scan', 'succeeded')])?.label).toBe(
      '2 steps',
    )
  })
})
