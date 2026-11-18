import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import type { RuleInput, Store } from '@holtkeeper/store'

import { ftsQuery } from './search.ts'
import { sqliteStore } from './sqlite.ts'

const rule = (id: string, title: string, body: string): RuleInput => ({
  id,
  title,
  body,
  scope: { all: true },
  author: 'jane',
  createdAt: '2026-10-30T09:00:00.000Z',
  updatedAt: '2026-10-30T09:00:00.000Z',
})

describe('ftsQuery', () => {
  test('quotes every word as a prefix term and drops syntax', () => {
    expect(ftsQuery('react migr')).toBe('"react"* OR "migr"*')
    expect(ftsQuery('"a" AND b* NEAR(c, d) -e col:f')).toBe(
      '"a"* OR "and"* OR "b"* OR "near"* OR "c"* OR "d"* OR "e"* OR "col"* OR "f"*',
    )
    expect(ftsQuery('Ünïcode ünïcode')).toBe('"ünïcode"*')
    expect(ftsQuery(' "*()" ')).toBeUndefined()
  })
})

describe('sqlite rule and learning search', () => {
  let store: Store
  beforeEach(() => {
    store = sqliteStore({ path: ':memory:' })
  })
  afterEach(async () => {
    await store.close()
  })

  test('bm25 prefers more matching words', async () => {
    await store.rules.put(rule('one', 'Locale files', 'Translations live in locales.'))
    await store.rules.put(rule('both', 'Locale fallback', 'Missing translations fall back to en.'))
    await store.rules.put(rule('none', 'Snapshots', 'No snapshots.'))
    const hits = await store.rules.search('fallback translations')
    expect(hits.map((h) => h.rule.id)).toEqual(['both', 'one'])
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score)
  })

  test('diacritics are folded and descriptions are searchable', async () => {
    await store.rules.put({
      ...rule('cafe', 'Menus', 'Use the café pattern.'),
      description: 'Read when touching dropdowns.',
    })
    expect((await store.rules.search('cafe')).map((h) => h.rule.id)).toEqual(['cafe'])
    expect((await store.rules.search('dropd')).map((h) => h.rule.id)).toEqual(['cafe'])
  })

  test('the learning index follows updates and deletes', async () => {
    const learning = {
      id: 'l',
      text: 'Prefer webpack aliases.',
      key: 'prefer webpack aliases',
      scope: { all: true },
      origin: 'person' as const,
      status: 'active' as const,
      sources: [],
      createdAt: '2026-10-30T09:00:00.000Z',
      updatedAt: '2026-10-30T09:00:00.000Z',
      activeAt: '2026-10-30T09:00:00.000Z',
      lastReinforcedAt: '2026-10-30T09:00:00.000Z',
      uses: 0,
      actedOn: 0,
      votesUp: 0,
      votesDown: 0,
    }
    await store.learnings.put(learning)
    await store.learnings.put({ ...learning, text: 'Prefer vite aliases.' })
    expect(await store.learnings.search('webpack')).toEqual([])
    expect((await store.learnings.search('vite')).map((h) => h.learning.id)).toEqual(['l'])
    await store.learnings.remove('l')
    expect(await store.learnings.search('vite')).toEqual([])
  })
})
