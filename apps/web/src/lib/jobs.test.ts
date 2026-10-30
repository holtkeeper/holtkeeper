import { expect, test } from 'bun:test'

import type { JobAnalyzerView } from '@holtkeeper/api'

import {
  analyzerLabel,
  analyzersFor,
  canCancelJob,
  isActiveJob,
  isJobStatus,
  jobDuration,
  jobStatusLabel,
  jobStatusTone,
  jobStatuses,
  jobTriggerLabel,
} from './jobs.ts'

const analyzer = (kind: string, scope: 'repo' | 'group'): JobAnalyzerView => ({
  kind,
  label: kind.toUpperCase(),
  scope,
  needs: {},
  schema: {},
})

test('statuses have labels and tones', () => {
  for (const status of jobStatuses) expect(jobStatusLabel(status)).not.toBe('')
  expect(jobStatusTone('running')).toBe('accent')
  expect(jobStatusTone('succeeded')).toBe('success')
  expect(jobStatusTone('failed')).toBe('danger')
  expect(jobStatusLabel('canceled')).toBe('Canceled')
  expect(jobTriggerLabel('poll')).toBe('Poll')
})

test('status parsing accepts only known statuses', () => {
  expect(isJobStatus('queued')).toBe(true)
  expect(isJobStatus('done')).toBe(false)
  expect(isJobStatus(undefined)).toBe(false)
})

test('only unfinished jobs can be cancelled', () => {
  expect(isActiveJob({ status: 'queued' })).toBe(true)
  expect(canCancelJob({ status: 'running' })).toBe(true)
  expect(canCancelJob({ status: 'succeeded' })).toBe(false)
  expect(canCancelJob({ status: 'canceled' })).toBe(false)
})

test('duration covers the latest attempt', () => {
  const startedAt = '2026-10-30T10:00:00.000Z'
  expect(jobDuration({ status: 'queued' })).toBeUndefined()
  expect(
    jobDuration({ status: 'succeeded', startedAt, finishedAt: '2026-10-30T10:01:30.000Z' }),
  ).toBe(90_000)
  expect(jobDuration({ status: 'running', startedAt }, new Date('2026-10-30T10:00:05.000Z'))).toBe(
    5_000,
  )
  expect(jobDuration({ status: 'queued', startedAt })).toBeUndefined()
})

test('analyzers are filtered by the fixed target', () => {
  const all = [analyzer('changelog', 'repo'), analyzer('inventory', 'group')]
  expect(analyzersFor(all, {}).map((a) => a.kind)).toEqual(['changelog', 'inventory'])
  expect(analyzersFor(all, { group: 'web' }).map((a) => a.kind)).toEqual(['inventory'])
  expect(analyzersFor(all, { repo: { forge: 'f', path: 'a/b' } }).map((a) => a.kind)).toEqual([
    'changelog',
  ])
  expect(analyzerLabel(all, 'changelog')).toBe('CHANGELOG')
  expect(analyzerLabel(all, 'other')).toBe('other')
})
