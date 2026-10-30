import { describe, expect, test } from 'bun:test'

import type { KnowledgeEntry } from '@holtkeeper/api'

import {
  countByStatus,
  draftOf,
  draftProblems,
  emptyDraft,
  entriesOfGroup,
  inputOf,
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
