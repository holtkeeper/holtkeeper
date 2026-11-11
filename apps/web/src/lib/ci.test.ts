import { describe, expect, test } from 'bun:test'

import type { CiJobStats } from '@holtkeeper/api'

import {
  changeLabel,
  failureTone,
  seconds,
  sortCiCards,
  stageColumns,
  successTone,
  unreliableJobs,
} from './ci.ts'

const job = (name: string, stage: string, extra: Partial<CiJobStats> = {}): CiJobStats => ({
  name,
  stage,
  runs: 10,
  pipelines: 10,
  failures: 0,
  retryRate: 0,
  flaky: 0,
  allowFailure: false,
  duration: { samples: 10, median: 60 },
  trend: 'stable',
  weeks: [],
  last: { at: '2026-10-01T00:00:00.000Z', status: 'success', href: `https://ci.test/${name}` },
  ...extra,
})

const card = (path: string, problems: number) => ({ repo: { forge: 'w', path }, problems })

describe('ci helpers', () => {
  test('durations and tones', () => {
    expect(seconds(185)).toBe('3 min 5 s')
    expect(seconds(undefined)).toBe('—')
    expect([failureTone(undefined), failureTone(4), failureTone(10), failureTone(30)]).toEqual([
      'success',
      'success',
      'warning',
      'danger',
    ])
    expect([successTone(undefined), successTone(98), successTone(70)]).toEqual([
      'default',
      'success',
      'danger',
    ])
  })

  test('a slower pipeline reads as bad, a small change stays neutral', () => {
    expect(changeLabel(12.4)).toEqual({ text: '↑ 12%', tone: 'danger' })
    expect(changeLabel(-8)).toEqual({ text: '↓ 8%', tone: 'success' })
    expect(changeLabel(3)).toEqual({ text: '↑ 3%', tone: 'default' })
    expect(changeLabel(0.2)).toEqual({ text: '± 0%', tone: 'default' })
    expect(changeLabel(undefined).text).toBe('')
  })

  test('stage columns follow the run order, keep unknown stages last and carry flags', () => {
    const columns = stageColumns(
      {
        stages: ['prepare', 'check'],
        jobs: [
          job('unit', 'check', { failureRate: 20 }),
          job('compile', 'prepare'),
          job('notes', 'extra', { allowFailure: true, failureRate: 50 }),
        ],
      },
      { unit: ['failing'] },
    )
    expect(columns.map((c) => [c.stage, c.jobs.map((j) => j.name)])).toEqual([
      ['prepare', ['compile']],
      ['check', ['unit']],
      ['extra', ['notes']],
    ])
    expect(columns[1]?.jobs[0]).toMatchObject({ tone: 'danger', flags: ['failing'], median: 60 })
    expect(columns[2]?.jobs[0]?.tone).toBe('default')
  })

  test('unreliable jobs: worst failure rate first, then most flaky', () => {
    const list = unreliableJobs([
      job('fine', 'a'),
      job('flaky', 'a', { flaky: 3 }),
      job('broken', 'a', { failures: 4, failureRate: 40 }),
      job('wobbly', 'a', { flaky: 1 }),
    ])
    expect(list.map((j) => j.name)).toEqual(['broken', 'flaky', 'wobbly'])
  })

  test('cards with problem jobs come first', () => {
    expect(sortCiCards([card('b', 0), card('c', 2), card('a', 0)]).map((c) => c.repo.path)).toEqual(
      ['c', 'a', 'b'],
    )
  })
})
