import { describe, expect, test } from 'bun:test'

import type { ScheduleRun, TriggerDocumentData } from '@holtkeeper/api'

import {
  automationView,
  cronFields,
  describeCadence,
  describeCron,
  describeDays,
  describeEvery,
  filterSchedules,
  inMyTeams,
  parseAutomationSearch,
  runCounts,
  runOutcome,
  runTicks,
  scheduleHealth,
  describeTrigger,
  describeWindows,
  isEvery,
  isHhmm,
  isIsoDate,
  looksLikeCron,
  toScheduleDraft,
  toScheduleInput,
  toTriggerDraft,
  toTriggerInput,
  triggerAnalyzers,
  triggerId,
  validateScheduleDraft,
  validateTriggerDraft,
} from './automation.ts'

describe('schedule values', () => {
  test('intervals, times, dates and cron shapes', () => {
    expect(isEvery('15m')).toBe(true)
    expect(isEvery('1d')).toBe(true)
    expect(isEvery('0h')).toBe(false)
    expect(isEvery('5x')).toBe(false)
    expect(isHhmm('09:30')).toBe(true)
    expect(isHhmm('24:00')).toBe(false)
    expect(isHhmm('9:30')).toBe(false)
    expect(isIsoDate('2026-12-24')).toBe(true)
    expect(isIsoDate('2026-13-01')).toBe(false)
    expect(looksLikeCron('0 3 * * 1-5')).toBe(true)
    expect(looksLikeCron('@daily')).toBe(true)
    expect(looksLikeCron('every day')).toBe(false)
  })

  test('cadence and windows in words', () => {
    expect(describeCadence({ every: '1h' })).toBe('Every hour')
    expect(describeCadence({ every: '15m' })).toBe('Every 15 minutes')
    expect(describeCadence({ every: '2d' })).toBe('Every 2 days')
    expect(describeCadence({ cron: '0 3 * * *' })).toBe('Every day at 03:00')
    expect(describeCadence({})).toBe('No cadence')
    expect(describeDays(['fri', 'mon', 'tue', 'wed', 'thu'])).toBe('Weekdays')
    expect(describeDays(['sun', 'sat'])).toBe('Weekends')
    expect(describeDays(['wed', 'mon'])).toBe('Mon, Wed')
    expect(
      describeWindows({
        allow: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '09:00', to: '18:00' }],
        deny: [{ days: ['fri'], from: '12:00', to: '13:00' }],
        skipWeekends: true,
        skipNights: { from: '22:00', to: '07:00' },
        holidays: ['2026-12-24', '2026-12-31'],
      }),
    ).toEqual([
      'Weekdays 09:00–18:00',
      'not Fri 12:00–13:00',
      'no weekends',
      'no nights 22:00–07:00',
      '2 holidays',
    ])
    expect(describeWindows(undefined)).toEqual([])
  })
})

describe('schedule form', () => {
  test('a blank draft runs daily and needs an id and analyzers', () => {
    const draft = toScheduleDraft()
    expect(draft.cadence).toBe('every')
    expect(draft.every).toBe('1d')
    expect(validateScheduleDraft(draft)).toEqual({
      id: 'Lowercase letters, digits and dashes',
      analyzers: 'Pick at least one analyzer',
    })
  })

  test('reports bad intervals, zones, windows, dates and jitter', () => {
    const draft = {
      ...toScheduleDraft(),
      id: 'nightly',
      analyzers: ['quality'],
      every: '5x',
      timezone: 'Mars/Base',
      repos: ['games/*'],
      allow: [{ days: [], from: '09:00', to: '18:00' }],
      deny: [{ days: ['fri' as const], from: '9:00', to: '18:00' }],
      skipNights: true,
      nightFrom: '25:00',
      holidays: ['24.12.2026'],
      jitterMinutes: '1.5',
    }
    expect(validateScheduleDraft(draft, ['nightly'])).toEqual({
      id: 'A schedule with this id exists',
      every: 'An interval such as 15m, 1h or 1d',
      timezone: 'An IANA time zone, e.g. Europe/Berlin',
      repos: 'Repositories are forge:path globs',
      allow: 'Pick at least one day for every window',
      deny: 'Times are HH:MM, e.g. 09:30',
      nights: 'Times are HH:MM, e.g. 22:00',
      holidays: 'Dates are YYYY-MM-DD',
      jitterMinutes: 'Whole minutes, 0 to 1440',
    })
    expect(validateScheduleDraft({ ...draft, cadence: 'cron', cron: 'nope' }).cron).toBe(
      'A cron expression, e.g. 0 3 * * 1-5',
    )
  })

  test('round-trips an entry and keeps options', () => {
    const data = {
      name: 'Office hours',
      enabled: false,
      analyzers: ['quality'],
      groups: ['games', ['frontend', 'storefront']],
      repos: ['work:games/*'],
      options: { quality: { depth: 2 } },
      every: '1h',
      timezone: 'Europe/Berlin',
      windows: {
        allow: [{ days: ['mon' as const, 'tue' as const], from: '09:00', to: '18:00' }],
        skipNights: { from: '22:00', to: '07:00' },
        holidays: ['2026-12-31', '2026-12-24'],
      },
      jitterMinutes: 10,
      spread: true,
    }
    const draft = toScheduleDraft({ type: 'schedule', id: 'office', data })
    expect(draft.groups).toEqual(['games', 'frontend + storefront'])
    expect(validateScheduleDraft(draft)).toEqual({})
    expect(toScheduleInput(draft)).toEqual({
      ...data,
      windows: { ...data.windows, holidays: ['2026-12-24', '2026-12-31'] },
    })
  })

  test('saves options only of picked analyzers that set something', () => {
    const draft = {
      ...toScheduleDraft(),
      id: 'nightly',
      every: '1d',
      analyzers: ['browserslist', 'deps'],
      options: { browserslist: { branch: 'chore/browserslist' }, deps: {}, quality: { depth: 2 } },
    }
    expect(toScheduleInput(draft).options).toEqual({
      browserslist: { branch: 'chore/browserslist' },
    })
    expect(toScheduleInput({ ...draft, analyzers: ['deps'] }).options).toBeUndefined()
  })

  test('leaves empty parts out and names the schedule by its id', () => {
    const draft = {
      ...toScheduleDraft(),
      id: 'nightly',
      cadence: 'cron' as const,
      cron: ' 0 3 * * * ',
      analyzers: ['deps'],
    }
    expect(toScheduleInput(draft)).toEqual({
      name: 'nightly',
      enabled: true,
      analyzers: ['deps'],
      cron: '0 3 * * *',
    })
    expect(
      toScheduleDraft({
        type: 'schedule',
        id: 'nightly',
        data: { name: 'nightly', enabled: true, analyzers: ['deps'], cron: '0 3 * * *' },
      }).name,
    ).toBe('')
  })
})

describe('triggers', () => {
  test('ids are fixed per kind', () => {
    expect(triggerId({ on: 'tag' })).toBe('tag')
    expect(triggerId({ on: 'mergeRequest' })).toBe('merge-request')
    expect(triggerId({ on: 'newRepo' })).toBe('new-repo')
    expect(triggerId({ on: 'label', label: ' needs-port ' })).toBe('label:needs-port')
    expect(triggerId({ on: 'command', command: 'port' })).toBe('command:port')
  })

  test('validation per kind and taken ids', () => {
    expect(validateTriggerDraft(toTriggerDraft(undefined, 'tag'))).toEqual({
      analyzers: 'Pick at least one analyzer',
    })
    expect(validateTriggerDraft(toTriggerDraft(undefined, 'label'))).toEqual({
      analyzers: 'Pick at least one analyzer',
      label: 'Enter the label',
    })
    expect(validateTriggerDraft(toTriggerDraft(undefined, 'newRepo'))).toEqual({})
    expect(validateTriggerDraft(toTriggerDraft(undefined, 'command'))).toEqual({
      command: 'Lowercase letters, digits, _ and -',
      analyzer: 'Pick the analyzer to run',
    })
    expect(
      validateTriggerDraft({ ...toTriggerDraft(undefined, 'tag'), analyzers: ['changelog'] }, [
        'tag',
      ]),
    ).toEqual({ id: 'This trigger exists; edit it instead' })
  })

  test('round-trips every kind', () => {
    const triggers: TriggerDocumentData[] = [
      { on: 'tag', analyzers: ['changelog'], groups: ['games'] },
      {
        on: 'mergeRequest',
        analyzers: ['review'],
        actions: ['open', 'reopen'],
        draft: true,
        groups: [['frontend', 'admin-panel']],
      },
      { on: 'newRepo' },
      { on: 'newRepo', exclude: ['quality'], groups: ['games'] },
      { on: 'newRepo', analyzers: ['audit', 'licenses'] },
      { on: 'label', label: 'needs-port', analyzers: ['port'] },
      { on: 'command', command: 'port', analyzer: 'port', args: ['targets'] },
    ]
    for (const trigger of triggers) {
      const draft = toTriggerDraft(structuredClone(trigger))
      expect(validateTriggerDraft(draft)).toEqual({})
      expect(toTriggerInput(draft)).toEqual(structuredClone(trigger))
    }
  })

  test('all merge request actions are the default', () => {
    const draft = {
      ...toTriggerDraft(undefined, 'mergeRequest'),
      analyzers: ['review'],
      actions: ['update' as const, 'open' as const, 'reopen' as const],
    }
    expect(toTriggerInput(draft)).toEqual({ on: 'mergeRequest', analyzers: ['review'] })
  })

  test('descriptions and analyzers', () => {
    expect(describeTrigger({ on: 'mergeRequest', analyzers: ['review'] })).toBe(
      'Merge request open, update, reopen',
    )
    expect(
      describeTrigger({ on: 'command', command: 'port', analyzer: 'port', args: ['targets'] }),
    ).toBe('/holtkeeper port <targets>')
    expect(triggerAnalyzers({ on: 'command', command: 'port', analyzer: 'port' })).toEqual(['port'])
    expect(triggerAnalyzers({ on: 'tag', analyzers: ['a', 'b'] })).toEqual(['a', 'b'])
  })
})

describe('cadence in words', () => {
  test('intervals', () => {
    expect(describeEvery('1m')).toBe('Every minute')
    expect(describeEvery('6h')).toBe('Every 6 hours')
    expect(describeEvery('1d')).toBe('Every day')
    expect(describeEvery(' 3d ')).toBe('Every 3 days')
    expect(describeEvery('soon')).toBe('soon')
  })

  test('cron at fixed times', () => {
    expect(describeCron('0 2 * * *')).toBe('Every day at 02:00')
    expect(describeCron('30 1 * * 1-5')).toBe('Weekdays at 01:30')
    expect(describeCron('0 10 * * 2,4')).toBe('Tue and Thu at 10:00')
    expect(describeCron('0 9 * * mon,wed,fri')).toBe('Mon, Wed and Fri at 09:00')
    expect(describeCron('0 7 * * 1')).toBe('Mondays at 07:00')
    expect(describeCron('0 8 * * 7')).toBe('Sundays at 08:00')
    expect(describeCron('0 12 * * 0,6')).toBe('Weekends at 12:00')
    expect(describeCron('0 6 * * 0-6')).toBe('Every day at 06:00')
    expect(describeCron('0 9,17 * * *')).toBe('Every day at 09:00 and 17:00')
    expect(describeCron('0 0 1 * *')).toBe('On day 1 of every month at 00:00')
    expect(describeCron('0 0 2 * * *')).toBe('Every day at 02:00')
    expect(describeCron('@daily')).toBe('Every day at 00:00')
    expect(describeCron('@weekly')).toBe('Sundays at 00:00')
  })

  test('cron that repeats within a day', () => {
    expect(describeCron('0 */6 * * *')).toBe('Every 6 hours')
    expect(describeCron('0 */4 * * 1-5')).toBe('Weekdays, every 4 hours')
    expect(describeCron('15 * * * *')).toBe('Every hour at :15')
    expect(describeCron('@hourly')).toBe('Every hour')
    expect(describeCron('*/15 * * * *')).toBe('Every 15 minutes')
    expect(describeCron('* * * * *')).toBe('Every minute')
  })

  test('anything fancier stays cron', () => {
    expect(describeCron('0 3 L * *')).toBe('Cron 0 3 L * *')
    expect(describeCron('0 3 * 1 *')).toBe('Cron 0 3 * 1 *')
    expect(describeCron('0 9-17 * * *')).toBe('Cron 0 9-17 * * *')
    expect(describeCron('whenever')).toBe('Cron whenever')
  })

  test('cron breakdown', () => {
    expect(cronFields('0 2 * * 1-5')).toEqual([
      { label: 'Minute', value: '0' },
      { label: 'Hour', value: '2' },
      { label: 'Day', value: '*' },
      { label: 'Month', value: '*' },
      { label: 'Weekday', value: '1-5' },
    ])
    expect(cronFields('30 0 2 * * *')?.map((field) => field.label)).toEqual([
      'Second',
      'Minute',
      'Hour',
      'Day',
      'Month',
      'Weekday',
    ])
    expect(cronFields('@monthly')?.map((field) => field.value)).toEqual(['0', '0', '1', '*', '*'])
    expect(cronFields('nope')).toBeUndefined()
  })
})

const run = (at: string, counts: Partial<ScheduleRun> = {}): ScheduleRun => ({
  at,
  jobs: 4,
  queued: 0,
  running: 0,
  succeeded: 4,
  failed: 0,
  blocked: 0,
  canceled: 0,
  analyzers: ['shapes'],
  failures: [],
  ...counts,
})

const ok = (at: string) => run(at)
const failed = (at: string) => run(at, { succeeded: 0, failed: 4 })

describe('schedule health', () => {
  test('outcome of a run from its counts', () => {
    expect(runOutcome(run('t', { queued: 1, succeeded: 3 }))).toBe('running')
    expect(runOutcome(failed('t'))).toBe('failed')
    expect(runOutcome(run('t', { succeeded: 3, failed: 1 }))).toBe('partial')
    expect(runOutcome(run('t', { succeeded: 2, blocked: 2 }))).toBe('blocked')
    expect(runOutcome(run('t', { jobs: 0, succeeded: 0 }))).toBe('skipped')
    expect(runOutcome(run('t', { succeeded: 0, canceled: 4 }))).toBe('skipped')
    expect(runOutcome(ok('t'))).toBe('succeeded')
  })

  test('read from the newest finished run, counting failures in a row', () => {
    const runs = [
      run('5', { running: 2, succeeded: 2 }),
      failed('4'),
      run('3', { jobs: 0, succeeded: 0 }),
      failed('2'),
      ok('1'),
    ]
    const health = scheduleHealth(runs, true)
    expect(health).toMatchObject({ state: 'failing', label: 'Failing', tone: 'danger' })
    expect(health.failedInRow).toBe(2)
    expect(health.last?.at).toBe('4')
    expect(scheduleHealth([run('2', { succeeded: 3, failed: 1 }), ok('1')], true).state).toBe(
      'partial',
    )
    expect(scheduleHealth([run('1', { succeeded: 3, blocked: 1 })], true).state).toBe('blocked')
    expect(scheduleHealth([ok('2'), failed('1')], true)).toMatchObject({
      state: 'healthy',
      failedInRow: 0,
    })
  })

  test('paused beats everything, no finished run is never', () => {
    expect(scheduleHealth([failed('1')], false).state).toBe('paused')
    expect(scheduleHealth([], true)).toMatchObject({ state: 'never', failedInRow: 0 })
    expect(scheduleHealth([run('1', { queued: 4, succeeded: 0 })], true).state).toBe('never')
    const ranks = ['failing', 'blocked', 'partial', 'never', 'healthy', 'paused'].map(
      (state) =>
        scheduleHealth(
          state === 'failing'
            ? [failed('1')]
            : state === 'blocked'
              ? [run('1', { succeeded: 3, blocked: 1 })]
              : state === 'partial'
                ? [run('1', { succeeded: 3, failed: 1 })]
                : state === 'never'
                  ? []
                  : [ok('1')],
          state !== 'paused',
        ).rank,
    )
    expect(ranks).toEqual([0, 1, 2, 3, 4, 5])
  })

  test('ticks oldest first and counts per outcome', () => {
    const runs = [failed('3'), ok('2'), ok('1')]
    expect(runTicks(runs, 2)).toEqual([
      { at: '2', outcome: 'succeeded' },
      { at: '3', outcome: 'failed' },
    ])
    expect(runCounts(runs)).toBe('2 succeeded · 1 failed')
    expect(runCounts([])).toBe('')
  })
})

const row = (id: string, state: 'failing' | 'healthy' | 'paused', lanes = ['all']) => ({
  id,
  name: id.toUpperCase(),
  lanes,
  analyzers: ['shapes', id === 'b' ? 'colors' : 'sizes'],
  health: scheduleHealth(state === 'failing' ? [failed('1')] : [ok('1')], state !== 'paused'),
})

describe('schedule list', () => {
  const rows = [
    row('c', 'healthy', ['toys']),
    row('a', 'paused'),
    row('b', 'failing', ['games']),
    row('d', 'healthy'),
  ]

  test('worst first, then by name', () => {
    expect(filterSchedules(rows, {}).map((r) => r.id)).toEqual(['b', 'c', 'd', 'a'])
  })

  test('text, team, status and problems', () => {
    expect(filterSchedules(rows, { q: 'COLOR' }).map((r) => r.id)).toEqual(['b'])
    expect(filterSchedules(rows, { q: ' d ' }).map((r) => r.id)).toEqual(['d'])
    expect(filterSchedules(rows, { teams: ['toys', 'all'] }).map((r) => r.id)).toEqual([
      'c',
      'd',
      'a',
    ])
    expect(filterSchedules(rows, { states: ['paused'] }).map((r) => r.id)).toEqual(['a'])
    expect(filterSchedules(rows, { problems: true }).map((r) => r.id)).toEqual(['b'])
  })

  test('my teams: every-repository rules and those of a home group', () => {
    expect(inMyTeams(['all'], [])).toBe(true)
    expect(inMyTeams(['toys'], ['toys'])).toBe(true)
    expect(inMyTeams(['toys'], ['games'])).toBe(false)
    expect(inMyTeams(['toys', 'games'], [['toys', 'games']])).toBe(true)
    expect(inMyTeams(['toys'], [['toys', 'games']])).toBe(false)
  })
})

describe('automation search', () => {
  test('keeps known values and drops defaults', () => {
    expect(
      parseAutomationSearch({
        view: 'map',
        tab: 'policies',
        lane: 'toys',
        rule: 'rule:trigger:push',
        job: 'job-1',
      }),
    ).toEqual({
      view: 'map',
      tab: 'policies',
      lane: 'toys',
      rule: 'rule:trigger:push',
      job: 'job-1',
    })
    expect(parseAutomationSearch({ view: 'list', tab: 'schedules', schedule: 'nightly' })).toEqual({
      schedule: 'nightly',
    })
    expect(
      parseAutomationSearch({ view: 'grid', tab: 'other', lane: '', job: 7, schedule: ['x'] }),
    ).toEqual({})
  })

  test('the map shows when asked for or when a job is explained', () => {
    expect(automationView({})).toBe('list')
    expect(automationView({ view: 'map' })).toBe('map')
    expect(automationView({ job: 'job-1' })).toBe('map')
  })
})
