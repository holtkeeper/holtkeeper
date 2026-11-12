import { describe, expect, test } from 'bun:test'

import {
  defaultScopeView,
  foldOtherTeams,
  foldScope,
  groupCounts,
  groupView,
  inHomeGroups,
  inView,
  parseScopeView,
  resolveScopeView,
  scopeList,
  viewGroup,
  viewGroups,
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
const groupsOf = (entry: { groups: readonly string[] }) => entry.groups

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
    expect(scoped.counts).toMatchObject({ mine: 2, all: 5 })
    expect(scoped.others).toEqual({ items: 3, teams: 3 })
  })

  test('all lists everything and still summarises the other teams', () => {
    const all = scopeList(items, 'all', [['gadgets', 'shared']])
    expect(names(all.shown)).toHaveLength(5)
    expect(all.counts).toMatchObject({ mine: 1, all: 5 })
    expect(all.others).toEqual({ items: 4, teams: 3 })
  })

  test('a group lists its items and every group is counted', () => {
    const scoped = scopeList(items, groupView('shared'), ['widgets'])
    expect(names(scoped.shown)).toEqual(['gadget-lib', 'shared-widget'])
    expect(scoped.counts.groups).toEqual([
      { group: 'gadgets', count: 1 },
      { group: 'shapes', count: 1 },
      { group: 'shared', count: 2 },
      { group: 'widgets', count: 2 },
    ])
  })

  test('group counts count an item once per group', () => {
    expect(groupCounts([['b', 'a', 'a'], ['a'], []])).toEqual([
      { group: 'a', count: 2 },
      { group: 'b', count: 1 },
    ])
  })

  test('the default is my teams, even without home groups', () => {
    expect(defaultScopeView).toBe('mine')
    expect(scopeList(items, 'mine', []).counts.mine).toBe(0)
    expect(scopeList(items, 'mine', []).shown).toEqual([])
  })

  test('parses stored positions; retired and unknown ones fall back to the default', () => {
    expect(parseScopeView('mine')).toBe('mine')
    expect(parseScopeView('all')).toBe('all')
    expect(parseScopeView('group:widgets')).toBe('group:widgets')
    expect(parseScopeView('group: widgets ')).toBe('group:widgets')
    expect(parseScopeView('group:')).toBeUndefined()
    expect(parseScopeView('others')).toBeUndefined()
    expect(parseScopeView('team')).toBeUndefined()
    expect(parseScopeView(null)).toBeUndefined()
    expect(resolveScopeView(parseScopeView('others'), ['widgets'])).toBe('mine')
  })

  test('a group position round-trips through its stored form', () => {
    const view = groupView('gadgets')
    expect(parseScopeView(view)).toBe(view)
    expect(viewGroup(view)).toBe('gadgets')
    expect(viewGroup('mine')).toBeUndefined()
    expect(viewGroup('all')).toBeUndefined()
  })

  test('a chosen group the viewer can no longer see falls back to the default', () => {
    expect(resolveScopeView('group:gadgets', ['gadgets', 'widgets'])).toBe('group:gadgets')
    expect(resolveScopeView('group:gone', ['gadgets'])).toBe('mine')
    expect(resolveScopeView('group:gone', undefined)).toBe('group:gone')
    expect(resolveScopeView('all', [])).toBe('all')
    expect(resolveScopeView(undefined, ['gadgets'])).toBe('mine')
  })

  test('membership and the server filter follow the position', () => {
    expect(inView('all', [], [])).toBe(true)
    expect(inView('mine', ['widgets'], ['widgets'])).toBe(true)
    expect(inView('mine', [], ['widgets'])).toBe(false)
    expect(inView('group:shapes', ['widgets'], ['shapes'])).toBe(true)
    expect(inView('group:shapes', ['shapes'], ['widgets'])).toBe(false)
    expect(viewGroups('all', ['widgets'])).toBeUndefined()
    expect(viewGroups('mine', ['widgets', ['gadgets', 'widgets']])).toEqual(['widgets', 'gadgets'])
    expect(viewGroups('mine', [])).toEqual([])
    expect(viewGroups('group:shapes', ['widgets'])).toEqual(['shapes'])
  })
})

describe('foldScope', () => {
  test('my teams folds other teams; items in no group stay', () => {
    const folded = foldScope(items, 'mine', ['widgets'], groupsOf)
    expect(names(folded.shown)).toEqual(['widget-app', 'loose-tool', 'shared-widget'])
    expect(names(folded.others)).toEqual(['gadget-lib', 'shape-kit'])
    expect(folded.teams).toEqual(['gadgets', 'shapes', 'shared'])
    expect(folded.counts).toMatchObject({ mine: 3, all: 5 })
  })

  test('a group shows its items and folds nothing', () => {
    const folded = foldScope(items, 'group:widgets', ['shapes'], groupsOf)
    expect(names(folded.shown)).toEqual(['widget-app', 'shared-widget'])
    expect(folded.others).toEqual([])
    expect(folded.teams).toEqual([])
    expect(folded.counts.groups).toContainEqual({ group: 'widgets', count: 2 })
  })

  test('my teams without home groups keeps only items in no group and folds nothing', () => {
    const folded = foldScope(items, 'mine', [], groupsOf)
    expect(names(folded.shown)).toEqual(['loose-tool'])
    expect(folded.others).toEqual([])
    expect(folded.counts).toMatchObject({ mine: 1, all: 5 })
  })

  test('my teams without home groups and nothing ungrouped shows nothing', () => {
    const folded = foldScope(items.slice(0, 3), 'mine', [], groupsOf)
    expect(folded.shown).toEqual([])
    expect(folded.counts).toMatchObject({ mine: 0, all: 3 })
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
