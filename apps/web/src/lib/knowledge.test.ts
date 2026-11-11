import { describe, expect, test } from 'bun:test'

import type { KnowledgeEntry } from '@holtkeeper/api'

import {
  countByStatus,
  draftOf,
  draftProblems,
  emptyDraft,
  entriesOfGroup,
  groupNotes,
  inputOf,
  isInherited,
  matchesFilter,
  notesOfSpace,
} from './knowledge.ts'

const entry = (overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry => ({
  id: 'k1',
  title: 'Use the facade',
  body: 'Never import the engine.',
  kind: 'convention',
  scope: { groups: ['games'] },
  topics: ['style'],
  appliesTo: ['review'],
  status: 'accepted',
  evidence: [],
  source: 'human',
  author: 'u1',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  version: 3,
  ...overrides,
})

describe('knowledge drafts', () => {
  test('an empty draft lists what is missing', () => {
    expect(draftProblems({ ...emptyDraft(), appliesTo: [], scope: { groups: [] } })).toEqual([
      'Add a title',
      'Add an explanation',
      'Choose where it applies',
      'Choose at least one task kind',
    ])
  })

  test('a migration needs a package with ecosystem and name', () => {
    const draft = { ...emptyDraft(), title: 't', body: 'b', kind: 'migration' as const }
    expect(draftProblems({ ...draft, packages: [{ ecosystem: 'npm', name: ' ' }] })).toEqual([
      'A migration names the package it is about',
    ])
    expect(draftProblems({ ...draft, packages: [{ ecosystem: 'npm', name: 'react' }] })).toEqual([])
  })

  test('inputOf trims, normalizes and drops blank rows', () => {
    expect(
      inputOf({
        ...emptyDraft({ groups: ['games', 'games'], repos: [] }),
        title: ' Title ',
        body: ' Body ',
        topics: ['Testing', 'testing', ' '],
        appliesTo: ['review', '*'],
        packages: [
          { ecosystem: 'npm', name: 'react', from: ' >=18 <19 ', to: '' },
          { ecosystem: '', name: '' },
        ],
        evidence: [
          { label: '', url: 'https://mr.test/1' },
          { label: 'x', url: '' },
        ],
      }),
    ).toEqual({
      title: 'Title',
      body: 'Body',
      kind: 'convention',
      scope: { groups: ['games'] },
      topics: ['testing'],
      appliesTo: ['*'],
      packages: [{ ecosystem: 'npm', name: 'react', from: '>=18 <19' }],
      evidence: [{ label: 'https://mr.test/1', url: 'https://mr.test/1' }],
    })
  })

  test('draftOf keeps the version for conflict checks', () => {
    expect(inputOf(draftOf(entry())).version).toBe(3)
  })

  test('visibility is left to the server by default; a subject is sent trimmed', () => {
    const draft = { ...emptyDraft(), title: 't', body: 'b' }
    expect(inputOf(draft)).not.toHaveProperty('visibility')
    expect(inputOf({ ...draft, visibility: 'shared', subject: ' npm:widget-kit ' })).toMatchObject({
      visibility: 'shared',
      subject: 'npm:widget-kit',
    })
    expect(draftOf(entry()).visibility).toBe('team')
  })

  test('group entries and status counts', () => {
    const list = [
      entry(),
      entry({ id: 'k2', scope: { all: true }, status: 'proposed' }),
      entry({ id: 'k3', scope: { groups: ['tools'] }, status: 'proposed' }),
    ]
    expect(entriesOfGroup(list, 'games').map((e) => e.id)).toEqual(['k1'])
    expect(countByStatus(list)).toEqual({ proposed: 2, accepted: 1, rejected: 0, archived: 0 })
  })
})

describe('notes of a space', () => {
  const list = [
    entry({ id: 'a', topics: ['testing'], updatedAt: '2026-10-02T00:00:00.000Z' }),
    entry({ id: 'b', topics: [], kind: 'quirk', scope: { repos: ['w:shapes/circle'] } }),
    entry({
      id: 'c',
      topics: ['testing'],
      status: 'proposed',
      scope: { groups: [['games', 'web']] },
    }),
    entry({ id: 'd', topics: ['api'], scope: { all: true }, status: 'archived' }),
  ]

  test('groups by first topic with entries without one last, proposals first', () => {
    expect(groupNotes(list, 'topic').map((g) => [g.label, g.entries.map((e) => e.id)])).toEqual([
      ['api', ['d']],
      ['testing', ['c', 'a']],
      ['No topic', ['b']],
    ])
  })

  test('groups by kind in kind order', () => {
    expect(groupNotes(list, 'kind').map((g) => g.label)).toEqual(['Convention', 'Quirk'])
  })

  test('a team space lists entries naming the team, also inside an intersection', () => {
    expect(notesOfSpace(list, { kind: 'group', group: 'games' }).map((e) => e.id)).toEqual([
      'a',
      'c',
    ])
    expect(
      notesOfSpace(list, { kind: 'family', family: 'f1' }, ['w:shapes/circle']).map((e) => e.id),
    ).toEqual(['b'])
    expect(notesOfSpace(list, { kind: 'all' })).toHaveLength(4)
  })

  test('a repository space marks entries that only cover it through a broader scope', () => {
    const space = { kind: 'repo' as const, repo: { forge: 'w', path: 'shapes/circle' } }
    expect(list.filter((e) => isInherited(e, space)).map((e) => e.id)).toEqual(['a', 'c', 'd'])
    expect(isInherited(list[0]!, { kind: 'all' })).toBe(false)
  })

  test('the live filter keeps proposals and accepted entries', () => {
    expect(list.filter((e) => matchesFilter(e, 'live')).map((e) => e.id)).toEqual(['a', 'b', 'c'])
    expect(list.filter((e) => matchesFilter(e, 'archived')).map((e) => e.id)).toEqual(['d'])
  })
})
