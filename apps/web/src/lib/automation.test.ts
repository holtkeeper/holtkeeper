import { describe, expect, test } from 'bun:test'

import type { TriggerDocumentData } from '@holtkeeper/api'

import {
  describeCadence,
  describeDays,
  describeTrigger,
  describeWindows,
  formatTraitValue,
  isEvery,
  isHhmm,
  isIsoDate,
  looksLikeCron,
  parseTraitValue,
  toScheduleDraft,
  toScheduleInput,
  toTraitRows,
  toTraitsDraft,
  toTraitsInput,
  toTriggerDraft,
  toTriggerInput,
  traitsDraftValid,
  traitsId,
  triggerAnalyzers,
  triggerId,
  validateScheduleDraft,
  validateTraitsDraft,
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
    expect(describeCadence({ cron: '0 3 * * *' })).toBe('Cron 0 3 * * *')
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
    const draft = toScheduleDraft({ type: 'schedule', id: 'office', provenance: 'panel', data })
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
        provenance: 'file',
        data: { name: 'nightly', enabled: true, analyzers: ['deps'], cron: '0 3 * * *' },
      }).name,
    ).toBe('')
  })
})

describe('triggers', () => {
  test('ids are fixed per kind', () => {
    expect(triggerId({ on: 'tag' })).toBe('tag')
    expect(triggerId({ on: 'mergeRequest' })).toBe('merge-request')
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

describe('repository traits', () => {
  test('values parse by type', () => {
    expect(parseTraitValue({ type: 'string', value: ' x ' })).toEqual({ value: ' x ' })
    expect(parseTraitValue({ type: 'number', value: '2.5' })).toEqual({ value: 2.5 })
    expect(parseTraitValue({ type: 'number', value: '' })).toEqual({ error: 'A number' })
    expect(parseTraitValue({ type: 'number', value: 'ten' })).toEqual({ error: 'A number' })
    expect(parseTraitValue({ type: 'boolean', value: 'true' })).toEqual({ value: true })
    expect(parseTraitValue({ type: 'boolean', value: 'yes' })).toEqual({ error: 'true or false' })
  })

  test('rows keep the type of each value', () => {
    expect(toTraitRows({ tier: 2, engine: 'unity', mobile: true })).toEqual([
      { key: 'engine', type: 'string', value: 'unity' },
      { key: 'mobile', type: 'boolean', value: 'true' },
      { key: 'tier', type: 'number', value: '2' },
    ])
  })

  test('validation and round trip', () => {
    expect(validateTraitsDraft(toTraitsDraft())).toEqual({
      pattern: 'Enter a path glob, e.g. games/*',
    })
    const draft = {
      pattern: 'games/*',
      forge: '',
      rows: [
        { key: 'tier', type: 'number' as const, value: 'x' },
        { key: 'tier', type: 'string' as const, value: 'a' },
        { key: '', type: 'string' as const, value: 'orphan' },
        { key: '', type: 'string' as const, value: '' },
      ],
    }
    const errors = validateTraitsDraft(draft, ['games/*'])
    expect(errors).toEqual({
      pattern: 'Traits for this pattern exist',
      rows: { 0: 'A number', 1: 'Duplicate name', 2: 'Name the trait' },
    })
    expect(traitsDraftValid(errors)).toBe(false)
    const data = { pattern: 'games/*', forge: 'work', traits: { engine: 'unity', tier: 2 } }
    const good = toTraitsDraft(data)
    expect(traitsDraftValid(validateTraitsDraft(good))).toBe(true)
    expect(
      toTraitsInput({ ...good, rows: [...good.rows, { key: '', type: 'string', value: '' }] }),
    ).toEqual(data)
  })

  test('ids and display values', () => {
    expect(traitsId('games/*')).toBe('games')
    expect(traitsId('games/**', ['games'])).toBe('games-2')
    expect(traitsId('**')).toBe('traits')
    expect(formatTraitValue('2')).toBe('"2"')
    expect(formatTraitValue('true')).toBe('"true"')
    expect(formatTraitValue('unity')).toBe('unity')
    expect(formatTraitValue(false)).toBe('false')
  })
})
