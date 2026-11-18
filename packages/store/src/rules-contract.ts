import { expect, test } from 'bun:test'

import { RuleVersionConflictError } from './rules.ts'
import type { RuleInput, Store } from './types.ts'

const at = (minute: number) => `2026-11-03T10:${String(minute).padStart(2, '0')}:00.000Z`

const rule = (id: string, overrides: Partial<RuleInput> = {}): RuleInput => ({
  id,
  title: 'Keep widgets pure',
  body: '- Do not read globals inside a widget.',
  scope: { teams: ['shapes'] },
  author: 'jane',
  createdAt: at(0),
  updatedAt: at(0),
  ...overrides,
})

/** Contract tests every `RuleStore` must pass. */
export function ruleStoreTests(store: () => Store) {
  test('rules: put bumps the version and keeps history, remove drops both', async () => {
    const rules = store().rules
    const first = await rules.put(rule('r1'))
    expect(first).toEqual({ ...rule('r1'), version: 1 })
    expect(await rules.get('r1')).toEqual(first)
    expect(await rules.history('r1')).toEqual([])

    const second = await rules.put(
      rule('r1', { title: 'Widgets stay pure', updatedAt: at(1), updatedBy: 'sam' }),
    )
    expect(second).toMatchObject({ version: 2, title: 'Widgets stay pure', updatedBy: 'sam' })
    await rules.put(
      rule('r1', {
        body: '- Pass state in.',
        files: ['src/widgets/**'],
        updatedAt: at(2),
        updatedBy: 'kim',
      }),
    )
    expect(await rules.get('r1')).toMatchObject({ version: 3, files: ['src/widgets/**'] })

    const history = await rules.history('r1')
    expect(history.map((revision) => revision.version)).toEqual([2, 1])
    expect(history[0]).toEqual({
      title: 'Widgets stay pure',
      body: '- Do not read globals inside a widget.',
      scope: { teams: ['shapes'] },
      version: 2,
      editedBy: 'sam',
      editedAt: at(1),
    })
    expect(history[1]).toMatchObject({ title: 'Keep widgets pure', editedBy: 'jane' })

    await rules.remove('r1')
    expect(await rules.get('r1')).toBeUndefined()
    expect(await rules.history('r1')).toEqual([])
    expect(await rules.history('missing')).toEqual([])
    expect(await rules.get('missing')).toBeUndefined()
    expect((await rules.put(rule('r1'))).version).toBe(1)
  })

  test('rules: optional fields round-trip and stay absent when unset', async () => {
    const rules = store().rules
    const full = rule('full', {
      scope: { repos: ['work:shapes/**'] },
      files: ['src/**/*.tsx', 'package.json'],
      agents: ['review', 'chat'],
      description: 'Use when touching widget state.',
      alwaysApply: false,
      updatedBy: 'sam',
    })
    expect(await rules.put(full)).toEqual({ ...full, version: 1 })
    expect(await rules.get('full')).toEqual({ ...full, version: 1 })

    await rules.put(rule('full', { updatedAt: at(1) }))
    const plain = await rules.get('full')
    for (const field of ['files', 'agents', 'description', 'alwaysApply', 'updatedBy'])
      expect(Object.hasOwn(plain!, field)).toBe(false)
    expect((await rules.history('full'))[0]).toMatchObject({
      files: ['src/**/*.tsx', 'package.json'],
      agents: ['review', 'chat'],
      description: 'Use when touching widget state.',
      alwaysApply: false,
      editedBy: 'sam',
    })
    expect(await rules.put(rule('all', { scope: { all: true }, alwaysApply: true }))).toMatchObject(
      { scope: { all: true }, alwaysApply: true },
    )
  })

  test('rules: expectedVersion guards against concurrent edits, 0 for a new rule', async () => {
    const rules = store().rules
    expect((await rules.put(rule('r'), 0)).version).toBe(1)
    const conflict = await rules.put(rule('r', { title: 'Lost' }), 0).catch((error) => error)
    expect(conflict).toBeInstanceOf(RuleVersionConflictError)
    expect(conflict).toMatchObject({ id: 'r', stored: 1 })
    expect((await rules.get('r'))?.title).toBe('Keep widgets pure')
    expect(await rules.history('r')).toEqual([])

    expect((await rules.put(rule('r', { title: 'Kept', updatedAt: at(1) }), 1)).version).toBe(2)
    expect(await rules.put(rule('r'), 1).catch((error) => error)).toBeInstanceOf(
      RuleVersionConflictError,
    )
    const fresh = await rules.put(rule('new'), 3).catch((error) => error)
    expect(fresh).toMatchObject({ id: 'new', stored: 0 })
    expect(await rules.get('new')).toBeUndefined()
    expect((await rules.put(rule('r', { updatedAt: at(2) }))).version).toBe(3)
  })

  test('rules: list sorts by title ignoring case, then id', async () => {
    const rules = store().rules
    await rules.put(rule('c', { title: 'beta' }))
    await rules.put(rule('a', { title: 'Gamma' }))
    await rules.put(rule('d', { title: 'Alpha' }))
    await rules.put(rule('b', { title: 'beta' }))
    expect((await rules.list()).map((r) => r.id)).toEqual(['d', 'b', 'c', 'a'])
    expect((await rules.list())[0]).toEqual({ ...rule('d', { title: 'Alpha' }), version: 1 })
  })

  test('rules: search ranks title over body, matches prefixes, blank text finds nothing', async () => {
    const rules = store().rules
    await rules.put(rule('body', { title: 'Release notes', body: 'Mention snapshot tests.' }))
    await rules.put(rule('title', { title: 'Snapshot tests are banned', body: 'See review.' }))
    await rules.put(rule('other', { title: 'Translations', body: 'Use ICU.' }))

    const hits = await rules.search('snapshot')
    expect(hits.map((hit) => hit.rule.id)).toEqual(['title', 'body'])
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score)
    expect(hits.every((hit) => hit.score > 0)).toBeTrue()
    expect(hits[0]?.rule).toEqual(await rules.get('title'))
    expect((await rules.search('transl')).map((hit) => hit.rule.id)).toEqual(['other'])
    expect(await rules.search('ICU snapshot', 2)).toHaveLength(2)
    expect(await rules.search('   ')).toEqual([])
    expect(await rules.search('nothing-like-this')).toEqual([])

    await rules.put(
      rule('title', { title: 'Fixtures', body: 'Keep them small.', updatedAt: at(1) }),
    )
    expect((await rules.search('snapshot')).map((hit) => hit.rule.id)).toEqual(['body'])
    await rules.remove('body')
    expect(await rules.search('snapshot')).toEqual([])
  })

  test('rules: search treats operators and punctuation as plain words', async () => {
    const rules = store().rules
    await rules.put(rule('ops', { title: 'NOT a drill', body: 'Use "quotes" AND (parens) x*y-z' }))
    const hostile = [
      '"',
      '"quotes',
      'AND',
      'OR OR',
      'NEAR(x y)',
      'title:drill',
      '*',
      '-z',
      '^drill',
      "it's",
      "\\ ' '' :* & | ! <->",
      '(((',
    ]
    for (const found of await Promise.all(hostile.map((query) => rules.search(query))))
      expect(Array.isArray(found)).toBeTrue()
    expect((await rules.search('"quotes"')).map((hit) => hit.rule.id)).toEqual(['ops'])
    expect((await rules.search('title:drill')).map((hit) => hit.rule.id)).toEqual(['ops'])
    expect((await rules.search('NOT')).map((hit) => hit.rule.id)).toEqual(['ops'])
  })
}
