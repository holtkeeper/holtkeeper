import { expect, test } from 'bun:test'

import type { JobAnalyzerView, JobStep } from '@holtkeeper/api'

import {
  analyzerLabel,
  analyzersFor,
  attemptDuration,
  attemptLabel,
  canCancelJob,
  isActiveJob,
  isJobStatus,
  jobDuration,
  jobStatusLabel,
  scheduleRunShares,
  scheduleRunState,
  jobStatusTone,
  jobStatuses,
  jobTriggerLabel,
  rerunJobInput,
  isJobTrigger,
  jobScopeRepos,
  jobsSearchWith,
  parseJobsSearch,
  stepBars,
  stepDuration,
  uniqueJobs,
  waitReasonText,
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
  expect(jobStatusLabel('blocked')).toBe('Blocked by budget')
  expect(jobStatusTone('blocked')).toBe('warning')
  expect(jobTriggerLabel('poll')).toBe('Poll')
  expect(jobTriggerLabel('command')).toBe('Command')
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

test('a rerun keeps the target, ref and options', () => {
  const repo = { forge: 'work', path: 'acme/game' }
  expect(
    rerunJobInput({ analyzer: 'coverage', repo, ref: 'development', options: { mode: 'full' } }),
  ).toEqual({
    analyzer: 'coverage',
    repo: 'work:acme/game',
    ref: 'development',
    options: { mode: 'full' },
  })
  expect(rerunJobInput({ analyzer: 'audit', repo, group: 'web', options: {} })).toEqual({
    analyzer: 'audit',
    group: 'web',
  })
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

test('a schedule run is unfinished, failed, blocked, canceled or done as a whole', () => {
  const run = { jobs: 4, queued: 0, running: 0, succeeded: 4, failed: 0, blocked: 0, canceled: 0 }
  expect(scheduleRunState(run)).toEqual({ label: 'Succeeded', tone: 'success' })
  expect(scheduleRunState({ ...run, running: 1 }).label).toBe('Running')
  expect(scheduleRunState({ ...run, queued: 2 }).label).toBe('Queued')
  expect(scheduleRunState({ ...run, succeeded: 3, failed: 1 }).label).toBe('Partly failed')
  expect(scheduleRunState({ ...run, succeeded: 0, failed: 4 }).label).toBe('Failed')
  expect(scheduleRunState({ ...run, succeeded: 0, canceled: 4 }).label).toBe('Canceled')
  expect(scheduleRunState({ ...run, succeeded: 3, blocked: 1 })).toEqual({
    label: 'Partly blocked by budget',
    tone: 'warning',
  })
  expect(scheduleRunState({ ...run, succeeded: 0, blocked: 4 }).label).toBe('Blocked by budget')
  expect(scheduleRunShares({ ...run, succeeded: 3, failed: 1 })).toEqual([
    { status: 'succeeded', count: 3, percent: 75 },
    { status: 'failed', count: 1, percent: 25 },
  ])
})

test('attempts have a duration once finished and a short label', () => {
  expect(
    attemptDuration({
      startedAt: '2026-10-30T10:00:00.000Z',
      finishedAt: '2026-10-30T10:00:05.000Z',
    }),
  ).toBe(5000)
  expect(attemptDuration({ startedAt: '2026-10-30T10:00:00.000Z' })).toBeUndefined()
  expect(attemptLabel({ n: 2, status: 'failed' })).toBe('#2 ✗')
  expect(attemptLabel({ n: 3, status: 'succeeded' })).toBe('#3 ✓')
})

test('jobScopeRepos splits targets by home groups and leaves All unfiltered', () => {
  const targets = [
    { repo: 'work:shapes/circle', groups: ['shapes'] },
    { repo: 'work:colors/red', groups: ['colors'] },
    { repo: 'work:shapes', group: 'shapes', groups: ['shapes'] },
  ]
  expect(jobScopeRepos('mine', targets, ['shapes'])).toEqual(['work:shapes/circle', 'work:shapes'])
  expect(jobScopeRepos('others', targets, ['shapes'])).toEqual(['work:colors/red'])
  expect(jobScopeRepos('all', targets, ['shapes'])).toBeUndefined()
  expect(jobScopeRepos('mine', undefined, ['shapes'])).toBeUndefined()
})

test('waitReasonText names what holds a queued job back', () => {
  const now = new Date('2026-02-03T10:00:00.000Z')
  expect(waitReasonText({ kind: 'same-analyzer', analyzer: 'widgets' }, now)).toBe(
    'A widgets job already runs on this repository',
  )
  expect(waitReasonText({ kind: 'after', analyzer: 'graph', state: 'queued' }, now)).toBe(
    'Waits for graph on this repository, whose results it reads',
  )
  expect(waitReasonText({ kind: 'exclusive-self', running: 2 }, now)).toContain('2 running jobs')
  expect(
    waitReasonText({ kind: 'retry', at: '2026-02-03T10:05:00.000Z', attempt: 1 }, now),
  ).toStartWith('Retries ')
})

const step = (name: string, at: string, ms?: number): JobStep => ({
  name,
  depth: 0,
  line: 0,
  startedAt: at,
  status: ms === undefined ? 'running' : 'succeeded',
  ...(ms !== undefined && { ms }),
})

test('stepBars places steps on the attempt timeline', () => {
  const bars = stepBars(
    [
      step('checkout', '2026-02-03T10:00:00.000Z', 2_500),
      step('analyze', '2026-02-03T10:00:05.000Z'),
    ],
    '2026-02-03T10:00:00.000Z',
    '2026-02-03T10:00:10.000Z',
  )
  expect(bars.map(({ left, width }) => [left, width])).toEqual([
    [0, 25],
    [50, 50],
  ])
  expect(stepDuration(step('x', '2026-02-03T10:00:00.000Z'))).toBe('running')
})

test('jobs search params keep known non-empty keys', () => {
  expect(parseJobsSearch({ status: 'failed', view: '', other: 'x', trigger: 3 })).toEqual({
    status: 'failed',
  })
  expect(jobsSearchWith({ status: 'failed', repo: 'work:a' }, { status: undefined })).toEqual({
    repo: 'work:a',
  })
  expect(isJobTrigger('push')).toBeTrue()
  expect(isJobTrigger('nope')).toBeFalse()
})

test('uniqueJobs drops jobs repeated across pages', () => {
  expect(
    uniqueJobs([
      [{ id: 'a' }, { id: 'b' }],
      [{ id: 'b' }, { id: 'c' }],
    ]),
  ).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
})
