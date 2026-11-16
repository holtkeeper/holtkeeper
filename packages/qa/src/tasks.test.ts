import { describe, expect, test } from 'bun:test'

import type { QaChange } from './model.ts'
import { catchAllMatcher, DEFAULT_CATCH_ALL_KEY, qaSettings } from './settings.ts'
import { changesSince, groupTasks, taskTitle } from './tasks.ts'

const web = { forge: 'work', path: 'acme/web' }
const api = { forge: 'work', path: 'acme/api' }

const change = (
  id: string,
  keys: string[],
  at: string,
  extra: Partial<QaChange> = {},
): QaChange => ({
  repo: web,
  kind: 'commit',
  id,
  branch: 'main',
  title: `title ${id}`,
  at,
  authors: ['Dev'],
  keys,
  commits: [id],
  head: id,
  ...extra,
})

describe('groupTasks', () => {
  test('groups changes of several repositories by key and leaves placeholders out', () => {
    const isCatchAll = catchAllMatcher([DEFAULT_CATCH_ALL_KEY])
    const { tasks, untracked } = groupTasks(
      [
        change('a', ['ABC-1'], '2026-10-03'),
        change('b', ['ABC-1', 'ABC-2'], '2026-10-02', { repo: api }),
        change('c', ['ABC-000'], '2026-10-04'),
        change('d', [], '2026-10-05'),
        change('e', ['ABC-000', 'ABC-3'], '2026-10-01'),
      ],
      { isCatchAll: (key) => isCatchAll(key) },
    )
    expect(untracked).toBe(2)
    expect(tasks.map((task) => [task.key, task.changes.map((item) => item.id)])).toEqual([
      ['ABC-1', ['a', 'b']],
      ['ABC-2', ['b']],
      ['ABC-3', ['e']],
    ])
    expect(tasks[0]?.repos).toEqual([web, api])
    expect(tasks[0]?.lastAt).toBe('2026-10-03')
  })

  test('takes titles from the tracker, then merge requests, then repeated commit titles', () => {
    const issue = { key: 'ABC-1', title: 'From the tracker' }
    const { tasks } = groupTasks([change('a', ['ABC-1'], '2026-10-01')], {
      issues: { 'ABC-1': issue },
    })
    expect(tasks[0]).toMatchObject({ title: 'From the tracker', issue })

    expect(
      taskTitle([
        change('a', [], '2026-10-03', { title: 'Newest commit' }),
        change('b', [], '2026-10-02', {
          title: 'Merge request title',
          mergeRequest: {
            id: 1,
            title: 'feat: Merge request title',
            description: '',
            sourceBranch: 'feature/x',
            author: 'dev',
            url: 'https://forge.example/mr/1',
            draft: false,
          },
        }),
      ]),
    ).toBe('Merge request title')
    expect(
      taskTitle([
        change('a', [], '2026-10-03', { title: 'Once' }),
        change('b', [], '2026-10-02', { title: 'Twice' }),
        change('c', [], '2026-10-01', { title: 'Twice' }),
      ]),
    ).toBe('Twice')
    expect(
      changesSince([change('a', [], '2026-10-03'), change('b', [], '2026-09-01')], '2026-10-01'),
    ).toHaveLength(1)
  })
})

describe('settings', () => {
  test('the default placeholder pattern matches zeros only, as whole keys', () => {
    const isCatchAll = catchAllMatcher([DEFAULT_CATCH_ALL_KEY])
    expect(['ABC-0', 'ABC-000', 'GAME2-00', 'X_TOOLS-0'].every(isCatchAll)).toBe(true)
    expect(['ABC-1', 'ABC-100', 'ABC-0001', 'abc-000'].some(isCatchAll)).toBe(false)
    const exact = catchAllMatcher(['ABC-999', '(oops'])
    expect(exact('ABC-999')).toBe(true)
    expect(exact('ABC-9990')).toBe(false)
  })

  test('applies defaults and reads broken values as the defaults', () => {
    expect(qaSettings()).toEqual({ enabled: true, catchAllKeys: [DEFAULT_CATCH_ALL_KEY] })
    expect(qaSettings({ branches: ['dev'], catchAllKeys: ['NOPE-1'] })).toMatchObject({
      branches: ['dev'],
      catchAllKeys: ['NOPE-1'],
    })
    expect(qaSettings({ catchAllKeys: ['(broken'] }).catchAllKeys).toEqual([DEFAULT_CATCH_ALL_KEY])
  })
})
