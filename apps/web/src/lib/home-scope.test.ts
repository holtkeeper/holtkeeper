import { describe, expect, test } from 'bun:test'

import {
  defaultScopeView,
  foldOtherTeams,
  inHomeGroups,
  parseScopeView,
  scopeList,
} from './home-scope.ts'

const item = (name: string, ...groups: string[]) => ({ name, groups })
const items = [
  item('widget-app', 'widgets'),
  item('gadget-lib', 'gadgets', 'shared'),
  item('shape-kit', 'shapes'),
  item('loose-tool'),
  item('shared-widget', 'widgets', 'shared'),
]
const names = (list: readonly { name: string }[]) => list.map((i) => i.name)

describe('home scope', () => {
  test('group entries match like grants: a combined entry needs every group', () => {
    expect(inHomeGroups(['widgets'], ['widgets', 'shared'])).toBe(true)
    expect(inHomeGroups([['widgets', 'shared']], ['widgets'])).toBe(false)
    expect(inHomeGroups([['widgets', 'shared']], ['shared', 'widgets'])).toBe(true)
    expect(inHomeGroups([], ['widgets'])).toBe(false)
  })

  test('my team lists the home groups and counts the rest by team', () => {
    const scoped = scopeList(items, 'mine', ['widgets'])
    expect(names(scoped.shown)).toEqual(['widget-app', 'shared-widget'])
    expect(scoped.counts).toEqual({ mine: 2, all: 5, others: 3 })
    expect(scoped.others).toEqual({ items: 3, teams: 3 })
  })

  test('all lists everything, other teams lists nothing but keeps the counts', () => {
    expect(names(scopeList(items, 'all', ['widgets']).shown)).toHaveLength(5)
    const others = scopeList(items, 'others', [['gadgets', 'shared']])
    expect(others.shown).toEqual([])
    expect(others.counts).toEqual({ mine: 1, all: 5, others: 4 })
    expect(others.others).toEqual({ items: 4, teams: 3 })
  })

  test('without home groups the default is everything', () => {
    expect(defaultScopeView([])).toBe('all')
    expect(defaultScopeView(['widgets'])).toBe('mine')
    expect(scopeList(items, 'mine', []).counts.mine).toBe(0)
  })

  test('parses stored positions', () => {
    expect(parseScopeView('others')).toBe('others')
    expect(parseScopeView('team')).toBeUndefined()
    expect(parseScopeView(null)).toBeUndefined()
  })
})

describe('foldOtherTeams', () => {
  const owned = [
    { id: 'circle', groups: ['shapes'] },
    { id: 'red', groups: ['colors'] },
    { id: 'blue', groups: ['colors', 'paint'] },
    { id: 'everyone', groups: [] },
  ]

  test('folds items of other teams and names those teams', () => {
    const folded = foldOtherTeams(owned, ['shapes'], (entry) => entry.groups)
    expect(folded.mine.map((entry) => entry.id)).toEqual(['circle', 'everyone'])
    expect(folded.others.map((entry) => entry.id)).toEqual(['red', 'blue'])
    expect(folded.teams).toEqual(['colors', 'paint'])
  })

  test('folds nothing without home groups', () => {
    const folded = foldOtherTeams(owned, [], (entry) => entry.groups)
    expect(folded.mine).toHaveLength(4)
    expect(folded.others).toEqual([])
  })

  test('an intersection home group needs every group', () => {
    const folded = foldOtherTeams(owned, [['colors', 'paint']], (entry) => entry.groups)
    expect(folded.mine.map((entry) => entry.id)).toEqual(['blue', 'everyone'])
    expect(folded.teams).toEqual(['shapes'])
  })
})
