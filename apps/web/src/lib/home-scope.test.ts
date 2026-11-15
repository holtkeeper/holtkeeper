import { describe, expect, test } from 'bun:test'

import {
  defaultScopeView,
  foldOtherTeams,
  foldScope,
  inHomeTeams,
  inView,
  parseScopeView,
  resolveScopeView,
  scopeLabel,
  scopeList,
  scopeSuffix,
  teamCounts,
  teamView,
  viewTeam,
  viewTeams,
} from './home-scope.ts'

const item = (name: string, ...teams: string[]) => ({ name, teams })
const items = [
  item('widget-app', 'widgets'),
  item('gadget-lib', 'gadgets', 'shared'),
  item('shape-kit', 'shapes'),
  item('loose-tool'),
  item('shared-widget', 'widgets', 'shared'),
]
const names = (list: readonly { name: string }[]) => list.map((i) => i.name)
const teamsOf = (entry: { teams: readonly string[] }) => entry.teams

const studioTitle = (key: string) => (key === 'shapes' ? 'Shape studio' : key)

describe('home scope', () => {
  test('an item belongs to the home teams when one of its owner teams is a home team', () => {
    expect(inHomeTeams(['widgets'], ['widgets', 'shared'])).toBe(true)
    expect(inHomeTeams(['gizmo'], ['widgets'])).toBe(false)
    expect(inHomeTeams([], ['widgets'])).toBe(false)
  })

  test('my teams lists the home teams and counts the rest by team', () => {
    const scoped = scopeList(items, 'mine', ['widgets'])
    expect(names(scoped.shown)).toEqual(['widget-app', 'shared-widget'])
    expect(scoped.counts).toMatchObject({ mine: 2, all: 5 })
    expect(scoped.others).toEqual({ items: 3, teams: 3 })
  })

  test('all lists everything and still summarises the other teams', () => {
    const all = scopeList(items, 'all', ['gadgets'])
    expect(names(all.shown)).toHaveLength(5)
    expect(all.counts).toMatchObject({ mine: 1, all: 5 })
    expect(all.others).toEqual({ items: 4, teams: 3 })
  })

  test('a team lists its items and every team is counted', () => {
    const scoped = scopeList(items, teamView('shared'), ['widgets'])
    expect(names(scoped.shown)).toEqual(['gadget-lib', 'shared-widget'])
    expect(scoped.counts.teams).toEqual([
      { team: 'gadgets', count: 1 },
      { team: 'shapes', count: 1 },
      { team: 'shared', count: 2 },
      { team: 'widgets', count: 2 },
    ])
  })

  test('team counts count an item once per team', () => {
    expect(teamCounts([['b', 'a', 'a'], ['a'], []])).toEqual([
      { team: 'a', count: 2 },
      { team: 'b', count: 1 },
    ])
  })

  test('the default is my teams, even without home teams', () => {
    expect(defaultScopeView).toBe('mine')
    expect(scopeList(items, 'mine', []).counts.mine).toBe(0)
    expect(scopeList(items, 'mine', []).shown).toEqual([])
  })

  test('parses stored positions; retired and unknown ones fall back to the default', () => {
    expect(parseScopeView('mine')).toBe('mine')
    expect(parseScopeView('all')).toBe('all')
    expect(parseScopeView('team:widgets')).toBe('team:widgets')
    expect(parseScopeView('team: widgets ')).toBe('team:widgets')
    expect(parseScopeView('team:')).toBeUndefined()
    expect(parseScopeView('group:widgets')).toBeUndefined()
    expect(parseScopeView('others')).toBeUndefined()
    expect(parseScopeView(null)).toBeUndefined()
    expect(resolveScopeView(parseScopeView('others'), ['widgets'])).toBe('mine')
  })

  test('a team position round-trips through its stored form', () => {
    const view = teamView('gadgets')
    expect(parseScopeView(view)).toBe(view)
    expect(viewTeam(view)).toBe('gadgets')
    expect(viewTeam('mine')).toBeUndefined()
    expect(viewTeam('all')).toBeUndefined()
  })

  test('a chosen team the viewer can no longer see falls back to the default', () => {
    expect(resolveScopeView('team:gadgets', ['gadgets', 'widgets'])).toBe('team:gadgets')
    expect(resolveScopeView('team:gone', ['gadgets'])).toBe('mine')
    expect(resolveScopeView('team:gone', undefined)).toBe('team:gone')
    expect(resolveScopeView('all', [])).toBe('all')
    expect(resolveScopeView(undefined, ['gadgets'])).toBe('mine')
  })

  test('membership and the server filter follow the position', () => {
    expect(inView('all', [], [])).toBe(true)
    expect(inView('mine', ['widgets'], ['widgets'])).toBe(true)
    expect(inView('mine', [], ['widgets'])).toBe(false)
    expect(inView('team:shapes', ['widgets'], ['shapes'])).toBe(true)
    expect(inView('team:shapes', ['shapes'], ['widgets'])).toBe(false)
    expect(viewTeams('all', ['widgets'])).toBeUndefined()
    expect(viewTeams('mine', ['widgets', 'gadgets', 'widgets'])).toEqual(['widgets', 'gadgets'])
    expect(viewTeams('mine', [])).toEqual([])
    expect(viewTeams('team:shapes', ['widgets'])).toEqual(['shapes'])
  })

  test('names a team position by its title', () => {
    expect(scopeLabel(teamView('shapes'), studioTitle)).toBe('Shape studio')
    expect(scopeSuffix(teamView('shapes'), studioTitle)).toBe(' in Shape studio')
    expect(scopeSuffix('mine')).toBe(' of my teams')
    expect(scopeLabel('all')).toBe('All I can see')
  })
})

describe('foldScope', () => {
  test('my teams folds other teams; items of no team stay', () => {
    const folded = foldScope(items, 'mine', ['widgets'], teamsOf)
    expect(names(folded.shown)).toEqual(['widget-app', 'loose-tool', 'shared-widget'])
    expect(names(folded.others)).toEqual(['gadget-lib', 'shape-kit'])
    expect(folded.teams).toEqual(['gadgets', 'shapes', 'shared'])
    expect(folded.counts).toMatchObject({ mine: 3, all: 5 })
  })

  test('a team shows its items and folds nothing', () => {
    const folded = foldScope(items, 'team:widgets', ['shapes'], teamsOf)
    expect(names(folded.shown)).toEqual(['widget-app', 'shared-widget'])
    expect(folded.others).toEqual([])
    expect(folded.teams).toEqual([])
    expect(folded.counts.teams).toContainEqual({ team: 'widgets', count: 2 })
  })

  test('my teams without home teams keeps only items of no team and folds nothing', () => {
    const folded = foldScope(items, 'mine', [], teamsOf)
    expect(names(folded.shown)).toEqual(['loose-tool'])
    expect(folded.others).toEqual([])
    expect(folded.counts).toMatchObject({ mine: 1, all: 5 })
  })

  test('my teams without home teams and nothing unowned shows nothing', () => {
    const folded = foldScope(items.slice(0, 3), 'mine', [], teamsOf)
    expect(folded.shown).toEqual([])
    expect(folded.counts).toMatchObject({ mine: 0, all: 3 })
  })
})

describe('foldOtherTeams', () => {
  const owned = [
    { id: 'circle', teams: ['shapes'] },
    { id: 'red', teams: ['colors'] },
    { id: 'blue', teams: ['colors', 'paint'] },
    { id: 'everyone', teams: [] },
  ]

  test('folds items of other teams and names those teams', () => {
    const folded = foldOtherTeams(owned, ['shapes'], (entry) => entry.teams)
    expect(folded.mine.map((entry) => entry.id)).toEqual(['circle', 'everyone'])
    expect(folded.others.map((entry) => entry.id)).toEqual(['red', 'blue'])
    expect(folded.teams).toEqual(['colors', 'paint'])
  })

  test('folds nothing without home teams', () => {
    const folded = foldOtherTeams(owned, [], (entry) => entry.teams)
    expect(folded.mine).toHaveLength(4)
    expect(folded.others).toEqual([])
  })

  test('a shared item stays when one of its owner teams is a home team', () => {
    const folded = foldOtherTeams(owned, ['paint'], (entry) => entry.teams)
    expect(folded.mine.map((entry) => entry.id)).toEqual(['blue', 'everyone'])
    expect(folded.teams).toEqual(['colors', 'shapes'])
  })
})
