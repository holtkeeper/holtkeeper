import { describe, expect, test } from 'bun:test'

import { parseConfig } from '@holtkeeper/core'
import { memoryStore } from '@holtkeeper/store/memory'

import {
  SCHEDULES_MARKER,
  defaultMarker,
  defaultSchedules,
  defaultTriggers,
  seedDefaults,
} from './defaults.ts'
import { scheduleDataSchema, triggerDataSchema } from './documents.ts'

const file = parseConfig({ forges: {}, groups: {} })
const now = () => new Date('2026-10-30T12:00:00.000Z')
const kinds = [
  'ci-jobs',
  'delivery',
  'depgraph',
  'quality',
  'coverage',
  'testids',
  'branches',
  'changelog',
]

describe('seedDefaults', () => {
  test('every default is a valid document', () => {
    for (const schedule of defaultSchedules)
      expect(scheduleDataSchema.parse(schedule.data)).toEqual(schedule.data)
    for (const trigger of defaultTriggers)
      expect(triggerDataSchema.parse(trigger.data)).toEqual(trigger.data)
  })

  test('writes each default once, dropping analyzers the server lacks', async () => {
    const store = memoryStore()
    expect(await seedDefaults({ store, file, analyzers: kinds, now })).toEqual([
      'schedule:ci-jobs-nightly',
      'schedule:delivery-weekly',
      'schedule:security-weekly',
      'schedule:quality-weekly',
      'schedule:tests-weekly',
      'schedule:branches-weekly',
      'trigger:tag',
    ])
    expect(await store.config?.get('schedule', 'security-weekly')).toMatchObject({
      updatedBy: 'system',
      data: { analyzers: ['depgraph'] },
    })
    expect((await store.config?.get('schedule', 'quality-weekly'))?.data).toMatchObject({
      analyzers: ['quality'],
      options: { quality: { coverage: 'skip' } },
    })
    expect((await store.config?.get('trigger', 'tag'))?.data).toEqual({
      on: 'tag',
      analyzers: ['changelog'],
    })
    expect((await store.activity.list())[0]?.action).toBe('config.defaults.seeded')

    await store.config?.remove('schedule', 'ci-jobs-nightly')
    expect(await seedDefaults({ store, file, analyzers: kinds, now })).toEqual([])
    expect(await store.config?.get('schedule', 'ci-jobs-nightly')).toBeUndefined()
  })

  test('installs seeded before add only the newer defaults', async () => {
    const store = memoryStore()
    await store.kv?.set(SCHEDULES_MARKER, { at: '2026-10-29T00:00:00.000Z' })
    expect(await seedDefaults({ store, file, analyzers: kinds, now })).toEqual([
      'schedule:quality-weekly',
      'schedule:tests-weekly',
      'schedule:branches-weekly',
      'trigger:tag',
    ])
  })

  test('a later default reaches installs that saw the earlier ones', async () => {
    const store = memoryStore()
    for (const id of ['ci-jobs-nightly', 'delivery-weekly', 'security-weekly', 'quality-weekly'])
      // oxlint-disable-next-line no-await-in-loop
      await store.kv?.set(defaultMarker('schedule', id), { at: '2026-10-29T00:00:00.000Z' })
    await store.kv?.set(defaultMarker('trigger', 'tag'), { at: '2026-10-29T00:00:00.000Z' })
    expect(await seedDefaults({ store, file, analyzers: kinds, now })).toEqual([
      'schedule:tests-weekly',
      'schedule:branches-weekly',
    ])
    expect((await store.config?.get('schedule', 'tests-weekly'))?.data).toMatchObject({
      analyzers: ['coverage', 'testids'],
      cron: '0 1 * * 3',
    })
  })

  test('keeps panel documents and file-configured schedules and tag triggers', async () => {
    const panel = memoryStore()
    await panel.config?.put({
      type: 'schedule',
      id: 'ci-jobs-nightly',
      data: { name: 'own', enabled: false, analyzers: ['ci-jobs'], every: '1d' },
      updatedAt: now().toISOString(),
    })
    await seedDefaults({ store: panel, file, analyzers: kinds, now })
    expect((await panel.config?.get('schedule', 'ci-jobs-nightly'))?.data.name).toBe('own')
    expect(await panel.kv?.get(defaultMarker('schedule', 'ci-jobs-nightly'))).toBeDefined()

    const store = memoryStore()
    const withFile = parseConfig({
      forges: {},
      groups: {},
      jobs: {
        schedules: [{ name: 'mine', cron: '0 3 * * *', analyzers: ['delivery'] }],
        onTag: { analyzers: ['changelog'] },
      },
    })
    expect(await seedDefaults({ store, file: withFile, analyzers: kinds, now })).toEqual([])
  })

  test('adds later analyzers to an existing tag trigger once', async () => {
    const store = memoryStore()
    const analyzers = [...kinds, 'api-surface']
    await store.kv?.set(defaultMarker('trigger', 'tag'), { at: now().toISOString() })
    await store.config?.put({
      type: 'trigger',
      id: 'tag',
      data: { on: 'tag', analyzers: ['changelog'] },
      updatedAt: now().toISOString(),
    })
    expect(await seedDefaults({ store, file, analyzers, now, schedules: [] })).toEqual([
      'trigger:tag+api-surface',
    ])
    expect((await store.config?.get('trigger', 'tag'))?.data).toEqual({
      on: 'tag',
      analyzers: ['changelog', 'api-surface'],
    })
    await store.config?.put({
      type: 'trigger',
      id: 'tag',
      data: { on: 'tag', analyzers: ['changelog'] },
      updatedAt: now().toISOString(),
    })
    expect(await seedDefaults({ store, file, analyzers, now, schedules: [] })).toEqual([])

    const fresh = memoryStore()
    expect(await seedDefaults({ store: fresh, file, analyzers, now, schedules: [] })).toEqual([
      'trigger:tag',
    ])
  })
})
