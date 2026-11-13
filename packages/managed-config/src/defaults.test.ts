import { describe, expect, test } from 'bun:test'

import { memoryStore } from '@holtkeeper/store/memory'

import {
  RETIRED_SCHEDULES_MARKER,
  defaultMarker,
  defaultTriggers,
  retireSeededSchedules,
  retiredScheduleIds,
  seedDefaults,
} from './defaults.ts'
import { triggerDataSchema } from './documents.ts'

const now = () => new Date('2026-10-30T12:00:00.000Z')
const kinds = ['ci-jobs', 'depgraph', 'licenses', 'api-surface']

describe('seedDefaults', () => {
  test('every default is a valid document', () => {
    for (const trigger of defaultTriggers)
      expect(triggerDataSchema.parse(trigger.data)).toEqual(trigger.data)
  })

  test('writes each default trigger once and no schedule', async () => {
    const store = memoryStore()
    expect(await seedDefaults({ store, analyzers: kinds, now })).toEqual([
      'trigger:tag',
      'trigger:new-repo',
    ])
    expect((await store.config?.get('trigger', 'tag'))?.data).toEqual({
      on: 'tag',
      analyzers: ['api-surface'],
    })
    expect(await store.config?.list('schedule')).toEqual([])
    expect((await store.audit.list()).events[0]?.action).toBe('config.seed')

    await store.config?.remove('trigger', 'new-repo')
    expect(await seedDefaults({ store, analyzers: kinds, now })).toEqual([])
    expect(await store.config?.get('trigger', 'new-repo')).toBeUndefined()
  })

  test('a later default reaches installs that saw the earlier ones', async () => {
    const store = memoryStore()
    await store.kv?.set(defaultMarker('tag'), { at: '2026-10-29T00:00:00.000Z' })
    expect(await seedDefaults({ store, analyzers: kinds, now })).toEqual(['trigger:new-repo'])
    expect((await store.config?.get('trigger', 'new-repo'))?.data).toEqual({ on: 'newRepo' })
  })

  test('keeps panel documents', async () => {
    const panel = memoryStore()
    await panel.config?.put({
      type: 'trigger',
      id: 'tag',
      data: { on: 'tag', analyzers: ['depgraph', 'api-surface'] },
      updatedAt: now().toISOString(),
    })
    await seedDefaults({ store: panel, analyzers: kinds, now })
    expect((await panel.config?.get('trigger', 'tag'))?.data).toEqual({
      on: 'tag',
      analyzers: ['depgraph', 'api-surface'],
    })
    expect(await panel.kv?.get(defaultMarker('tag'))).toBeDefined()
  })

  test('adds later analyzers to an existing tag trigger once', async () => {
    const store = memoryStore()
    await store.kv?.set(defaultMarker('tag'), { at: now().toISOString() })
    await store.config?.put({
      type: 'trigger',
      id: 'tag',
      data: { on: 'tag', analyzers: ['depgraph'] },
      updatedAt: now().toISOString(),
    })
    expect(await seedDefaults({ store, analyzers: kinds, now })).toEqual([
      'trigger:new-repo',
      'trigger:tag+api-surface',
    ])
    expect((await store.config?.get('trigger', 'tag'))?.data).toEqual({
      on: 'tag',
      analyzers: ['depgraph', 'api-surface'],
    })
    await store.config?.put({
      type: 'trigger',
      id: 'tag',
      data: { on: 'tag', analyzers: ['depgraph'] },
      updatedAt: now().toISOString(),
    })
    expect(await seedDefaults({ store, analyzers: kinds, now })).toEqual([])
  })
  test('adds starter knowledge to a new-repo trigger that lists analyzers, never to one without a list', async () => {
    const listed = memoryStore()
    await listed.kv?.set(defaultMarker('new-repo'), { at: now().toISOString() })
    await listed.config?.put({
      type: 'trigger',
      id: 'new-repo',
      data: { on: 'newRepo', analyzers: ['depgraph'] },
      updatedAt: now().toISOString(),
    })
    const withBootstrap = [...kinds, 'knowledge-bootstrap']
    expect(await seedDefaults({ store: listed, analyzers: withBootstrap, now })).toEqual([
      'trigger:tag',
      'trigger:new-repo+knowledge-bootstrap',
    ])
    expect((await listed.config?.get('trigger', 'new-repo'))?.data).toEqual({
      on: 'newRepo',
      analyzers: ['depgraph', 'knowledge-bootstrap'],
    })
    expect(await seedDefaults({ store: listed, analyzers: withBootstrap, now })).toEqual([])

    const open = memoryStore()
    expect(await seedDefaults({ store: open, analyzers: withBootstrap, now })).toEqual([
      'trigger:tag',
      'trigger:new-repo',
    ])
    expect((await open.config?.get('trigger', 'new-repo'))?.data).toEqual({ on: 'newRepo' })
  })
})

const schedule = (id: string) => ({
  type: 'schedule' as const,
  id,
  data: { name: id, enabled: true, cron: '0 3 * * *', analyzers: ['depgraph'] },
  updatedAt: now().toISOString(),
  updatedBy: 'system',
})

describe('retireSeededSchedules', () => {
  test('removes the old seeded schedules once and audits it', async () => {
    const store = memoryStore()
    for (const id of ['ci-jobs-nightly', 'guide-weekly', 'renovate-nightly', 'nightly-widgets'])
      // oxlint-disable-next-line no-await-in-loop -- test setup
      await store.config?.put(schedule(id))
    expect(await retireSeededSchedules({ store, now })).toEqual([
      'ci-jobs-nightly',
      'guide-weekly',
      'renovate-nightly',
    ])
    expect((await store.config?.list('schedule'))?.map((doc) => doc.id)).toEqual([
      'nightly-widgets',
    ])
    expect(await store.kv?.get(RETIRED_SCHEDULES_MARKER)).toBeDefined()
    const [event] = (await store.audit.list()).events
    expect(event?.action).toBe('config.retire-schedules')
    expect(event?.via).toBe('system')
    expect(event?.details).toEqual({
      schedules: ['ci-jobs-nightly', 'guide-weekly', 'renovate-nightly'],
    })

    await store.config?.put(schedule('api-weekly'))
    expect(await retireSeededSchedules({ store, now })).toEqual([])
    expect(await store.config?.get('schedule', 'api-weekly')).toBeDefined()
  })

  test('covers every schedule id the earlier defaults seeded', () => {
    expect(retiredScheduleIds).toContain('tests-weekly')
    expect(retiredScheduleIds).toHaveLength(13)
  })

  test('tries again on the next start when a delete fails', async () => {
    const store = memoryStore()
    const config = store.config
    if (!config) throw new Error('memory store has config')
    await config.put(schedule('ci-jobs-nightly'))
    const remove = config.remove.bind(config)
    config.remove = () => Promise.reject(new Error('store hiccup'))
    let failure: unknown
    try {
      await retireSeededSchedules({ store, now })
    } catch (error) {
      failure = error
    }
    expect(String(failure)).toContain('store hiccup')
    config.remove = remove
    expect(await store.kv?.get(RETIRED_SCHEDULES_MARKER)).toBeUndefined()
    expect(await retireSeededSchedules({ store, now })).toEqual(['ci-jobs-nightly'])
  })

  test('keeps a seeded schedule a person edited', async () => {
    const store = memoryStore()
    await store.config?.put(schedule('guide-weekly'))
    await store.config?.put({ ...schedule('ci-jobs-nightly'), updatedBy: 'user:alex' })
    expect(await retireSeededSchedules({ store, now })).toEqual(['guide-weekly'])
    expect(await store.config?.get('schedule', 'ci-jobs-nightly')).toBeDefined()
  })

  test('audits nothing when no old schedule is stored', async () => {
    const store = memoryStore()
    expect(await retireSeededSchedules({ store, now })).toEqual([])
    expect((await store.audit.list()).events).toEqual([])
  })
})
