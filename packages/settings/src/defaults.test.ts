import { describe, expect, test } from 'bun:test'

import { memoryStore } from '@holtkeeper/store/memory'

import { DEFAULTS_MARKER, defaultSettings, seedDefaultSettings } from './defaults.ts'
import { builtinSettings } from './definitions.ts'

const now = () => new Date('2026-10-30T10:00:00Z')

describe('defaultSettings', () => {
  test('every default passes its built-in schema', () => {
    for (const { key, value } of defaultSettings) {
      const definition = builtinSettings.find((candidate) => candidate.key === key)
      expect(definition, key).toBeDefined()
      expect(definition?.schema.safeParse(value).success, key).toBe(true)
    }
  })

  test('routes triage to Haiku and review to Opus through @latest references', () => {
    const models = defaultSettings.find((entry) => entry.key === 'llm.models')?.value
    expect(models).toMatchObject({ triage: 'claude-haiku@latest', review: 'claude-opus@latest' })
  })
})

describe('builtin presets', () => {
  test('pass their schema and have unique ids', () => {
    for (const definition of builtinSettings) {
      const presets = definition.presets ?? []
      expect(new Set(presets.map((preset) => preset.id)).size).toBe(presets.length)
      for (const preset of presets)
        expect(definition.schema.safeParse(preset.value).success, preset.id).toBe(true)
    }
  })
})

describe('seedDefaultSettings', () => {
  test('seeds an empty store for everything and logs it', async () => {
    const store = memoryStore()
    const keys = await seedDefaultSettings({ store, definitions: builtinSettings, now })
    expect(keys).toEqual(defaultSettings.map((entry) => entry.key))
    const entries = await store.settings.list()
    expect(entries).toHaveLength(keys.length)
    expect(entries.every((entry) => entry.scope.all === true && !entry.secret)).toBe(true)
    expect((await store.settings.get('default:llm.model'))?.value).toBe('claude-opus@latest')
    const [event] = await store.activity.list()
    expect(event).toMatchObject({ actor: 'system', action: 'settings.seeded', details: { keys } })
  })

  test('seeds once, even after every setting was removed', async () => {
    const store = memoryStore()
    await seedDefaultSettings({ store, definitions: builtinSettings, now })
    await Promise.all((await store.settings.list()).map((entry) => store.settings.remove(entry.id)))
    expect(await seedDefaultSettings({ store, definitions: builtinSettings, now })).toEqual([])
    expect(await store.settings.list()).toEqual([])
  })

  test('leaves a store with settings alone and does not seed it later', async () => {
    const store = memoryStore()
    const entry = {
      id: 'mine',
      key: 'llm.model',
      scope: { all: true },
      value: 'gpt-5',
      secret: false,
      updatedAt: '2026-10-01T00:00:00Z',
    }
    await store.settings.put(entry)
    expect(await seedDefaultSettings({ store, definitions: builtinSettings, now })).toEqual([])
    expect(await store.settings.list()).toEqual([entry])
    expect(await store.kv?.get(DEFAULTS_MARKER)).toBeDefined()
    await store.settings.remove('mine')
    expect(await seedDefaultSettings({ store, definitions: builtinSettings, now })).toEqual([])
  })

  test('concurrent calls seed once', async () => {
    const store = memoryStore()
    const results = await Promise.all([
      seedDefaultSettings({ store, definitions: builtinSettings, now }),
      seedDefaultSettings({ store, definitions: builtinSettings, now }),
    ])
    expect(results.filter((keys) => keys.length > 0)).toHaveLength(1)
    expect(await store.activity.list()).toHaveLength(1)
  })

  test('without kv relies on the store being empty', async () => {
    const { kv: _kv, ...store } = memoryStore()
    expect(await seedDefaultSettings({ store, definitions: builtinSettings, now })).not.toEqual([])
    expect(await seedDefaultSettings({ store, definitions: builtinSettings, now })).toEqual([])
  })

  test('skips unknown keys and values their schema rejects', async () => {
    const store = memoryStore()
    const keys = await seedDefaultSettings({
      store,
      definitions: builtinSettings,
      defaults: [
        { key: 'nope', value: 1 },
        { key: 'audit.upgrade', value: 'huge' },
        { key: 'audit.fix', value: false },
      ],
      now,
    })
    expect(keys).toEqual(['audit.fix'])
  })
})
