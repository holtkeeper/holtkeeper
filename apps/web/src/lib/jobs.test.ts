import { expect, test } from 'bun:test'

import type { JobAnalyzerView, JobStats, JobStep, JobSummary } from '@holtkeeper/api'

import {
  analyzerLabel,
  analyzersFor,
  attemptDuration,
  attemptLabel,
  canCancelJob,
  claimDelay,
  costCapShare,
  costCapText,
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
  executionModeLabel,
  optionsSummary,
  parseJobsSearch,
  queueFigures,
  runCostText,
  runStartedText,
  runSubline,
  runsFilter,
  runsSegment,
  runsSegmentWith,
  stepBars,
  stepDuration,
  uniqueJobs,
  waitBuckets,
  waitHintText,
  waitKindText,
  waitReasonText,
  workerStateText,
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
  expect(jobStatusTone('running')).toBe('info')
  expect(jobStatusTone('succeeded')).toBe('success')
  expect(jobStatusTone('failed')).toBe('danger')
  expect(jobStatusLabel('canceled')).toBe('Canceled')
  expect(jobStatusLabel('blocked')).toBe('Blocked by budget')
  expect(jobStatusTone('blocked')).toBe('code')
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
    tone: 'code',
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
  expect(attemptLabel({ n: 2, status: 'failed' })).toBe('#2 Failed')
  expect(attemptLabel({ n: 3, status: 'running' })).toBe('#3 Running')
})

test('jobScopeRepos splits targets by home groups and leaves All unfiltered', () => {
  const targets = [
    { repo: 'work:shapes/circle', groups: ['shapes'] },
    { repo: 'work:colors/red', groups: ['colors'] },
    { repo: 'work:shapes', group: 'shapes', groups: ['shapes'] },
  ]
  expect(jobScopeRepos('mine', targets, ['shapes'])).toEqual(['work:shapes/circle', 'work:shapes'])
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
  expect(parseJobsSearch({ status: 'failed', view: '', other: 'x', trigger: 3, q: 'wid' })).toEqual(
    { status: 'failed', q: 'wid' },
  )
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

test('segments fix the status and switching drops the status filter', () => {
  expect(runsSegment({})).toBe('all')
  expect(runsSegment({ view: 'failures' })).toBe('failures')
  expect(runsSegment({ view: 'queue' })).toBe('queue')
  expect(runsSegment({ view: 'other' })).toBe('all')
  expect(runsSegmentWith({ status: 'running', repo: 'work:acme/widget' }, 'queue')).toEqual({
    view: 'queue',
    repo: 'work:acme/widget',
  })
  expect(runsSegmentWith({ view: 'failures', q: 'x' }, 'all')).toEqual({ q: 'x' })
})

test('runsFilter builds list filters from the segment and pills', () => {
  expect(runsFilter({ status: 'running', trigger: 'push', analyzer: 'widgets' })).toEqual({
    status: 'running',
    trigger: 'push',
    analyzer: 'widgets',
  })
  expect(runsFilter({ view: 'failures', status: 'running', signature: 'boom' })).toEqual({
    status: 'failed',
    signature: 'boom',
  })
  expect(runsFilter({ view: 'queue', schedule: 'nightly' })).toEqual({
    status: 'queued',
    schedule: 'nightly',
  })
  expect(runsFilter({ status: 'done', trigger: 'nope' })).toEqual({})
  expect(runsFilter({ q: '  widget ' })).toEqual({ q: 'widget' })
  expect(runsFilter({ q: '   ' })).toEqual({})
})

test('wait hints name the first reason or the free worker slot', () => {
  const now = new Date('2026-02-03T10:00:00.000Z')
  expect(waitHintText({ reasons: [], ahead: 0 }, now)).toBe('Waits for a free worker slot')
  expect(waitHintText({ reasons: [], ahead: 4 }, now)).toBe('Waits for a free worker slot, 4 ahead')
  expect(
    waitHintText(
      {
        reasons: [
          { kind: 'after', analyzer: 'graph', state: 'running' },
          { kind: 'exclusive-self', running: 1 },
        ],
        ahead: 2,
      },
      now,
      (kind) => kind.toUpperCase(),
    ),
  ).toBe('Waits for GRAPH on this repository, whose results it reads (+1 more)')
})

test('wait buckets read as counted phrases, largest first', () => {
  expect(waitKindText('capacity', 5)).toBe('5 wait for a free worker slot')
  expect(waitKindText('scheduled', 1)).toBe('1 is not due yet')
  expect(
    waitBuckets({
      waits: {
        sampled: 9,
        reasons: [
          { kind: 'retry', count: 1 },
          { kind: 'capacity', count: 5 },
          { kind: 'after', count: 0 },
        ],
      },
    }).map((bucket) => bucket.kind),
  ).toEqual(['capacity', 'retry'])
})

const stats: JobStats = {
  at: '2026-02-03T10:00:00.000Z',
  windowHours: 24,
  queue: { queued: 9, running: 3, failed: 7, blocked: 1 },
  claimLatency: { samples: 40, p50Ms: 18_000, p95Ms: 100_000 },
  waits: { sampled: 9, reasons: [] },
  running: { jobs: 3, costUsd: 0.54 },
}

test('queue figures cover workers only when the stats list them', () => {
  const figures = queueFigures(stats)
  expect(figures.map((figure) => figure.value)).toEqual([9, 3, '18 s', 7, 1])
  expect(figures[1]?.caption).toBe('· $0.54 so far')
  expect(figures[2]?.caption).toBe('· p95 1 min 40 s')
  expect(figures[3]?.label).toBe('failed in 24 h')
  const withWorkers = queueFigures({
    ...stats,
    running: { jobs: 0, costUsd: 0 },
    claimLatency: { samples: 0 },
    workers: [
      { id: 'worker-1', lastSeen: stats.at, running: 2 },
      { id: 'worker-2', lastSeen: stats.at, running: 0 },
    ],
  })
  expect(withWorkers[0]).toEqual({ prefix: 'Workers busy', value: '1 / 2', label: '' })
  expect(withWorkers[2]?.caption).toBeUndefined()
  expect(withWorkers[3]?.value).toBe('—')
  expect(workerStateText({ running: 2 })).toBe('Busy · 2 runs')
  expect(workerStateText({ running: 0 })).toBe('Idle')
})

test('cost helpers show the run cost against its cap', () => {
  expect(runCostText(undefined)).toBe('—')
  expect(runCostText(0.42)).toBe('$0.42')
  expect(costCapText(0.42)).toBe('$0.42')
  expect(costCapText(0.42, 2)).toBe('$0.42 of $2.00 cap')
  expect(costCapShare(0.5, 2)).toBe(25)
  expect(costCapShare(3, 2)).toBe(100)
  expect(costCapShare(1)).toBeUndefined()
  expect(costCapShare(1, 0)).toBeUndefined()
})

const run = (patch: Partial<JobSummary>): JobSummary => ({
  id: 'ab12cd34',
  analyzer: 'widgets',
  repo: { forge: 'work', path: 'acme/shop' },
  options: {},
  trigger: 'push',
  status: 'queued',
  attempts: 0,
  maxAttempts: 3,
  attemptsHistory: [],
  runAfter: '2026-02-03T09:58:00.000Z',
  createdAt: '2026-02-03T09:57:50.000Z',
  ...patch,
})

test('the started cell shows waiting time, due time or start', () => {
  const now = new Date('2026-02-03T10:00:00.000Z')
  expect(runStartedText(run({}), now)).toBe('waiting 2 min 10 s')
  expect(runStartedText(run({ runAfter: '2026-02-03T10:05:00.000Z' }), now)).toBe(
    'due in 5 minutes',
  )
  expect(
    runStartedText(run({ status: 'running', startedAt: '2026-02-03T09:50:00.000Z' }), now),
  ).toBe('10 minutes ago')
  expect(claimDelay(run({}))).toBeUndefined()
  expect(claimDelay(run({ startedAt: '2026-02-03T09:59:56.000Z' }))).toBe(116_000)
})

test('sublines explain queued, blocked, failed and retried runs', () => {
  const now = new Date('2026-02-03T10:00:00.000Z')
  expect(runSubline(run({}), { reasons: [], ahead: 0 }, now)).toEqual({
    text: 'Waits for a free worker slot',
    tone: 'muted',
  })
  expect(runSubline(run({}), undefined, now)).toBeUndefined()
  expect(runSubline(run({ status: 'blocked' }))?.tone).toBe('warning')
  expect(
    runSubline(
      run({ status: 'failed', error: 'heap out of memory\n  at frame', errorSignature: '' }),
    ),
  ).toEqual({ text: 'heap out of memory', tone: 'danger' })
  expect(
    runSubline(run({ status: 'failed', errorSignature: 'scan: lockfile missing' }))?.text,
  ).toBe('scan: lockfile missing')
  const attempts: JobSummary['attemptsHistory'] = [
    { n: 1, status: 'failed', startedAt: now.toISOString(), error: 'forge 502\nretrying' },
    { n: 2, status: 'running', startedAt: now.toISOString() },
  ]
  expect(runSubline(run({ status: 'running', attemptsHistory: attempts }))).toEqual({
    text: 'Attempt 1: forge 502',
    tone: 'muted',
  })
  expect(runSubline(run({ status: 'succeeded' }))).toBeUndefined()
})

test('options read as one line and the execution mode in words', () => {
  expect(optionsSummary({})).toBe('')
  expect(optionsSummary({ fix: true, level: 'moderate' })).toBe('fix: true · level: moderate')
  expect(optionsSummary({ a: 1, b: [2], c: 'x' })).toBe('a: 1 · b: [2] · 3 options')
  expect(executionModeLabel('mise')).toBe('mise mode')
})
