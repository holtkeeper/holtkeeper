import { describe, expect, test } from 'bun:test'

import type { ChangeItem } from '@holtkeeper/api'

import {
  conflictsByChange,
  mergeRequestTitle,
  safeIds,
  selectAllSafe,
  selectedIds,
  toggle,
} from './selection.ts'

const item = (id: string, confidence: 'safe' | 'review', source = 'oxlint'): ChangeItem => ({
  change: { id, title: `Fix ${id}`, confidence, source, edits: [] },
  diff: [],
})

const items = [item('a', 'safe'), item('b', 'review'), item('c', 'safe', 'conventions')]

describe('selection', () => {
  test('toggle and order', () => {
    const selected = toggle(toggle(new Set(), 'c', true), 'a', true)
    expect(selectedIds(selected, items)).toEqual(['a', 'c'])
    expect(selectedIds(toggle(selected, 'a', false), items)).toEqual(['c'])
    expect(selectedIds(new Set(['gone', 'b']), items)).toEqual(['b'])
  })

  test('select all safe skips review and conflicting changes', () => {
    const conflicts = conflictsByChange([{ changeId: 'c', file: 'x.ts', reason: 'moved on' }])
    expect(safeIds(items, conflicts)).toEqual(['a'])
    expect(selectedIds(selectAllSafe(new Set(['b']), items), items)).toEqual(['a', 'b', 'c'])
    expect(conflicts.get('c')?.[0]?.file).toBe('x.ts')
  })

  test('merge request titles', () => {
    expect(mergeRequestTitle(items, ['a'])).toBe('Fix a')
    expect(mergeRequestTitle(items, ['a', 'b'])).toBe('Apply 2 suggested changes from oxlint')
    expect(mergeRequestTitle(items, ['a', 'c'])).toBe('Apply 2 suggested changes')
  })
})
