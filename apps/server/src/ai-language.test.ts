import { describe, expect, test } from 'bun:test'

import { parseConfig } from '@holtkeeper/core'
import { memoryStore } from '@holtkeeper/store/memory'

import { aiLanguageOf } from './ai-language.ts'

const config = parseConfig({
  forges: { work: { kind: 'gitlab', url: 'https://gitlab.test', create: () => ({}) as never } },
})
const widget = { forge: 'work', path: 'shapes/widget' }
const gadget = { forge: 'work', path: 'shapes/gadget' }

const review = (id: string, scope: { all?: boolean; repos?: string[] }, value: unknown) => ({
  id,
  key: 'analyzers.review',
  scope,
  value,
  secret: false,
  updatedAt: '2026-10-01T00:00:00.000Z',
})

describe('aiLanguageOf', () => {
  test('falls back to English without a usable setting', async () => {
    const store = memoryStore()
    expect(await aiLanguageOf({ config, store }, widget)).toBe('English')
    await store.settings.put(review('global', { all: true }, { language: '  ' }))
    expect(await aiLanguageOf({ config, store }, widget)).toBe('English')
  })

  test('a repository value wins over the global one', async () => {
    const store = memoryStore()
    await store.settings.put(review('global', { all: true }, { language: 'German' }))
    await store.settings.put(review('own', { repos: ['shapes/widget'] }, { language: 'French' }))
    expect(await aiLanguageOf({ config, store }, widget)).toBe('French')
    expect(await aiLanguageOf({ config, store }, gadget)).toBe('German')
  })
})
