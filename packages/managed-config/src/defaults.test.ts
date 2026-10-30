import { describe, expect, test } from 'bun:test'

import { parseConfig } from '@holtkeeper/core'
import { memoryStore } from '@holtkeeper/store/memory'

import { SCHEDULES_MARKER, defaultSchedules, seedDefaultSchedules } from './defaults.ts'
import { scheduleDataSchema } from './documents.ts'

const file = parseConfig({ forges: {}, groups: {} })
const now = () => new Date('2026-10-30T12:00:00.000Z')
const kinds = ['ci-jobs', 'delivery', 'depgraph']

describe('seedDefaultSchedules', () => {
  test('every default is a valid schedule document', () => {
    for (const schedule of defaultSchedules)
      expect(scheduleDataSchema.parse(schedule.data)).toEqual(schedule.data)
  })

  test('writes the defaults once, dropping analyzers the server lacks', async () => {
    const store = memoryStore()
    const written = await seedDefaultSchedules({ store, file, analyzers: kinds, now })
    expect(written).toEqual(['ci-jobs-nightly', 'delivery-weekly', 'security-weekly'])
    const security = await store.config?.get('schedule', 'security-weekly')
    expect(security).toMatchObject({ updatedBy: 'system', data: { analyzers: ['depgraph'] } })
    expect((await store.activity.list())[0]?.action).toBe('config.schedules.seeded')

    await store.config?.remove('schedule', 'ci-jobs-nightly')
    expect(await seedDefaultSchedules({ store, file, analyzers: kinds, now })).toEqual([])
    expect(await store.config?.get('schedule', 'ci-jobs-nightly')).toBeUndefined()
  })

  test('leaves installs that already have schedules alone', async () => {
    const store = memoryStore()
    const withFile = parseConfig({
      forges: {},
      groups: {},
      jobs: { schedules: [{ name: 'mine', cron: '0 3 * * *', analyzers: ['delivery'] }] },
    })
    expect(await seedDefaultSchedules({ store, file: withFile, analyzers: kinds, now })).toEqual([])
    expect(await store.kv?.get(SCHEDULES_MARKER)).toEqual({ at: '2026-10-30T12:00:00.000Z' })

    const panel = memoryStore()
    await panel.config?.put({
      type: 'schedule',
      id: 'own',
      data: { name: 'own', enabled: true, analyzers: ['delivery'], every: '1d' },
      updatedAt: now().toISOString(),
    })
    expect(await seedDefaultSchedules({ store: panel, file, analyzers: kinds, now })).toEqual([])
  })
})
