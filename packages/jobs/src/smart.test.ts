import { describe, expect, test } from 'bun:test'

import {
  isAllowedAt,
  nextRuns,
  runWindowEnd,
  schedulePresets,
  type ScheduleTiming,
} from './smart.ts'

const iso = (dates: Date[]) => dates.map((date) => date.toISOString().slice(0, 16))
const at = (value: string) => new Date(`${value}:00.000Z`)
const berlin = 'Europe/Berlin'
const newYork = 'America/New_York'

describe('nextRuns: cron', () => {
  test('keeps local time across the spring DST change', () => {
    const runs = nextRuns({ cron: '0 3 * * *', timezone: berlin }, at('2026-03-27T12:00'), 3)
    expect(iso(runs)).toEqual(['2026-03-28T02:00', '2026-03-29T01:00', '2026-03-30T01:00'])
  })

  test('keeps local time across the autumn DST change', () => {
    const runs = nextRuns({ cron: '30 8 * * *', timezone: newYork }, at('2026-10-31T00:00'), 2)
    expect(iso(runs)).toEqual(['2026-10-31T12:30', '2026-11-01T13:30'])
  })

  test('a run in a denied window moves to the next allowed minute, once', () => {
    const schedule: ScheduleTiming = {
      cron: '0 * * * *',
      timezone: berlin,
      windows: { skipNights: { from: '22:00', to: '07:00' } },
    }
    expect(iso(nextRuns(schedule, at('2026-10-30T20:30'), 3))).toEqual([
      '2026-10-31T06:00',
      '2026-10-31T07:00',
      '2026-10-31T08:00',
    ])
  })

  test('holidays and weekends are skipped', () => {
    const schedule: ScheduleTiming = {
      ...schedulePresets.nightly(),
      timezone: berlin,
      windows: { holidays: ['2026-11-03'], skipWeekends: true },
    }
    // Friday 30 Oct after the run; Monday 2 Nov runs; Tuesday 3 Nov is a holiday, so its run
    // moves to Wednesday 00:00 and Wednesday's own run follows.
    expect(iso(nextRuns(schedule, at('2026-10-30T04:00'), 3))).toEqual([
      '2026-11-02T02:00',
      '2026-11-03T23:00',
      '2026-11-04T02:00',
    ])
  })
})

describe('nextRuns: every', () => {
  test('aligns to the start of allowed windows', () => {
    const schedule: ScheduleTiming = {
      ...schedulePresets.workHours({ to: '12:00' }),
      timezone: berlin,
    }
    // Friday 30 Oct 10:30 local (CET); next week starts Monday 09:00 local.
    expect(iso(nextRuns(schedule, at('2026-10-30T09:30'), 4))).toEqual([
      '2026-10-30T10:00',
      '2026-11-02T08:00',
      '2026-11-02T09:00',
      '2026-11-02T10:00',
    ])
  })

  test('restarts after a denied window', () => {
    const schedule: ScheduleTiming = {
      every: '45m',
      timezone: 'UTC',
      windows: { deny: [{ days: ['fri'], from: '12:00', to: '13:00' }] },
    }
    expect(iso(nextRuns(schedule, at('2026-10-30T11:00'), 3))).toEqual([
      '2026-10-30T11:15',
      '2026-10-30T13:00',
      '2026-10-30T13:45',
    ])
  })

  test('counts elapsed time over the repeated hour in autumn', () => {
    const runs = nextRuns({ every: '15m', timezone: newYork }, at('2026-11-01T05:50'), 3)
    expect(iso(runs)).toEqual(['2026-11-01T06:00', '2026-11-01T06:15', '2026-11-01T06:30'])
  })

  test('skips the missing hour in spring', () => {
    const runs = nextRuns({ every: '1h', timezone: berlin }, at('2026-03-28T22:30'), 3)
    expect(iso(runs)).toEqual(['2026-03-28T23:00', '2026-03-29T00:00', '2026-03-29T01:00'])
  })

  test('whole days run at the first allowed minute of the day', () => {
    const schedule: ScheduleTiming = {
      every: '1d',
      timezone: berlin,
      windows: {
        allow: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '09:00', to: '18:00' }],
      },
    }
    expect(iso(nextRuns(schedule, at('2026-10-30T12:00'), 2))).toEqual([
      '2026-11-02T08:00',
      '2026-11-03T08:00',
    ])
  })
})

describe('nextRuns: jitter and limits', () => {
  test('jitter is stable, bounded and keeps runs ordered', () => {
    const schedule: ScheduleTiming = {
      name: 'nightly',
      cron: '0 * * * *',
      timezone: 'UTC',
      jitterMinutes: 20,
    }
    const first = nextRuns(schedule, at('2026-10-30T00:30'), 24)
    expect(iso(first)).toEqual(iso(nextRuns(schedule, at('2026-10-30T00:30'), 24)))
    for (const [index, run] of first.entries()) {
      const minute = run.getUTCMinutes()
      expect(minute).toBeLessThanOrEqual(20)
      expect(run.getUTCHours()).toBe((index + 1) % 24)
    }
    expect(new Set(first.map((run) => run.getUTCMinutes())).size).toBeGreaterThan(1)
  })

  test('nothing allowed means no runs', () => {
    const schedule: ScheduleTiming = { every: '1h', timezone: 'UTC', windows: { allow: [] } }
    expect(
      nextRuns(
        { ...schedule, windows: { skipNights: { from: '00:00', to: '00:00' } } },
        at('2026-10-30T00:00'),
        1,
      ),
    ).toEqual([])
    expect(nextRuns(schedule, at('2026-10-30T00:00'), 0)).toEqual([])
  })
})

describe('windows', () => {
  test('a window past midnight belongs to the day it starts', () => {
    const schedule: ScheduleTiming = {
      cron: '* * * * *',
      timezone: 'UTC',
      windows: { allow: [{ days: ['fri'], from: '22:00', to: '02:00' }] },
    }
    expect(isAllowedAt(schedule, at('2026-10-30T23:00'))).toBeTrue()
    expect(isAllowedAt(schedule, at('2026-10-31T01:59'))).toBeTrue()
    expect(isAllowedAt(schedule, at('2026-10-31T02:00'))).toBeFalse()
    expect(isAllowedAt(schedule, at('2026-10-31T23:00'))).toBeFalse()
  })

  test('runWindowEnd stops at the window end or the next run', () => {
    const work: ScheduleTiming = { ...schedulePresets.workHours(), timezone: 'UTC' }
    expect(runWindowEnd(work, at('2026-10-30T09:00')).toISOString()).toBe(
      '2026-10-30T10:00:00.000Z',
    )
    const night: ScheduleTiming = {
      cron: '0 3 * * *',
      timezone: 'UTC',
      windows: { allow: [{ days: ['fri'], from: '01:00', to: '05:00' }] },
    }
    expect(runWindowEnd(night, at('2026-10-30T03:00')).toISOString()).toBe(
      '2026-10-30T05:00:00.000Z',
    )
  })

  test('presets', () => {
    expect(schedulePresets.nightly()).toEqual({ cron: '0 3 * * 1-5' })
    expect(schedulePresets.nightly({ at: '02:30', weekends: true })).toEqual({ cron: '30 2 * * *' })
    expect(schedulePresets.weekly({ day: 'sun', at: '07:15' })).toEqual({ cron: '15 7 * * 0' })
    expect(schedulePresets.workHours({ every: '30m' }).every).toBe('30m')
  })
})
