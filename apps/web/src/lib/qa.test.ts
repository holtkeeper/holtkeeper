import { describe, expect, test } from 'bun:test'

import type { QaChangeView, QaTaskRow } from '@holtkeeper/api'

import {
  changeLabel,
  changesByRepo,
  countsText,
  filterTasks,
  parseQaPeriod,
  stalenessText,
  testIdSummary,
} from './qa.ts'

const app = { forge: 'work', path: 'shapes/app' }
const lib = { forge: 'work', path: 'shapes/lib' }

const change = (overrides: Partial<QaChangeView>): QaChangeView => ({
  repo: app,
  kind: 'commit',
  id: 'abc1234',
  branch: 'main',
  title: 'Widget',
  at: '2026-10-01T00:00:00.000Z',
  authors: ['Dana'],
  keys: ['ABC-1'],
  commits: ['abc1234'],
  head: 'abc1234',
  ...overrides,
})

const ref = (value: string) => ({ attribute: 'data-testid', value })

const row = (overrides: Partial<QaTaskRow>): QaTaskRow => ({
  key: 'ABC-1',
  title: 'Widget panel',
  repos: [app],
  teams: [],
  lastAt: '2026-10-01T00:00:00.000Z',
  counts: { merged: 0, open: 0, direct: 0 },
  authors: ['Dana'],
  ...overrides,
})

describe('qa helpers', () => {
  test('reads periods and writes counts', () => {
    expect(parseQaPeriod('7')).toBe(7)
    expect(parseQaPeriod(90)).toBe(90)
    expect(parseQaPeriod('5')).toBe(30)
    expect(countsText({ merged: 2, open: 0, direct: 1 })).toBe('2 merged · 1 direct')
    expect(countsText({ merged: 0, open: 0, direct: 0 })).toBe('—')
  })

  test('filters tasks by key, title, repository and author', () => {
    const rows = [row({}), row({ key: 'ABC-2', title: 'Gadget', repos: [lib], authors: ['Lee'] })]
    expect(filterTasks(rows, 'abc-2').map((item) => item.key)).toEqual(['ABC-2'])
    expect(filterTasks(rows, 'panel').map((item) => item.key)).toEqual(['ABC-1'])
    expect(filterTasks(rows, 'shapes/lib').map((item) => item.key)).toEqual(['ABC-2'])
    expect(filterTasks(rows, 'lee').map((item) => item.key)).toEqual(['ABC-2'])
    expect(filterTasks(rows, ' ')).toHaveLength(2)
  })

  test('groups changes by repository in order', () => {
    const groups = changesByRepo([
      change({ id: 'a' }),
      change({ id: 'b', repo: lib }),
      change({ id: 'c' }),
    ])
    expect(groups.map((group) => [group.repo.path, group.changes.map((item) => item.id)])).toEqual([
      ['shapes/app', ['a', 'c']],
      ['shapes/lib', ['b']],
    ])
  })

  test('merges test attribute changes, a later change undoing an earlier one', () => {
    const summary = testIdSummary([
      change({
        id: 'new',
        detail: {
          files: [],
          testIds: [{ file: 'a.vue', added: [ref('keep')], removed: [ref('temp')] }],
        },
      }),
      change({
        id: 'old',
        detail: {
          files: [],
          testIds: [{ file: 'a.vue', added: [ref('temp')], removed: [ref('gone')] }],
        },
      }),
    ])
    expect(summary).toEqual([{ file: 'a.vue', added: [ref('keep')], removed: [ref('gone')] }])
  })

  test('labels changes and staleness', () => {
    expect(changeLabel('work:shapes/app!12')).toBe('shapes/app !12')
    expect(changeLabel('work:shapes/app@abc1234')).toBe('shapes/app abc1234')
    expect(stalenessText({ added: ['x', 'y'], removed: [], updated: ['z'] })).toBe(
      '2 new changes, 1 updated',
    )
    expect(stalenessText({ added: ['x'], removed: ['y'], updated: [] })).toBe(
      '1 new change, 1 gone',
    )
  })
})
