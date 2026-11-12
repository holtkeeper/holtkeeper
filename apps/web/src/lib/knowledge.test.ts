import { describe, expect, test } from 'bun:test'

import type { KnowledgeEntry, KnowledgeRevision } from '@holtkeeper/api'

import {
  changedFields,
  draftOf,
  draftProblems,
  emptyDraft,
  filterNotes,
  groupNotes,
  inputOf,
  isInherited,
  kbId,
  matchesFilter,
  noteLink,
  noteSections,
  noteTopics,
  noteTotals,
  noteVersions,
  notesOfSpace,
  restoreInput,
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

describe('notes table', () => {
  const list = [
    entry({ id: 'aa11', title: 'Widgets are immutable', topics: ['state'] }),
    entry({
      id: 'bb22',
      title: 'Retry through fooUtil',
      kind: 'quirk',
      topics: ['retries', 'state'],
      status: 'proposed',
      updatedAt: '2026-10-03T00:00:00.000Z',
    }),
    entry({
      id: 'cc33',
      title: 'Old shape',
      topics: [],
      status: 'proposed',
      updatedAt: '2026-10-05T00:00:00.000Z',
    }),
    entry({ id: 'dd44', status: 'rejected', topics: ['state'] }),
    entry({ id: 'ee55', scope: { all: true }, visibility: 'shared', topics: [] }),
  ]
  const live = { filter: 'live' as const, text: '', kinds: [], topics: [] }

  test('proposals lead under Waiting for review, newest first, the rest by topic', () => {
    expect(
      noteSections(filterNotes(list, live), 'topic').map((s) => [
        s.label,
        s.entries.map((e) => e.id),
      ]),
    ).toEqual([
      ['Waiting for review', ['cc33', 'bb22']],
      ['state', ['aa11']],
      ['No topic', ['ee55']],
    ])
  })

  test('filters by text, kb id, kind and topic', () => {
    expect(filterNotes(list, { ...live, text: 'FOOUTIL' }).map((e) => e.id)).toEqual(['bb22'])
    expect(filterNotes(list, { ...live, text: 'kb:aa' }).map((e) => e.id)).toEqual(['aa11'])
    expect(filterNotes(list, { ...live, kinds: ['quirk'] }).map((e) => e.id)).toEqual(['bb22'])
    expect(filterNotes(list, { ...live, topics: ['state'] }).map((e) => e.id)).toEqual([
      'aa11',
      'bb22',
    ])
    expect(filterNotes(list, { ...live, filter: 'rejected' }).map((e) => e.id)).toEqual(['dd44'])
    expect(noteTopics(list)).toEqual(['retries', 'state'])
  })

  test('filters by task and groups by status', () => {
    const tasks = [
      entry({ id: 'p1', appliesTo: ['port'] }),
      entry({ id: 'r1', appliesTo: ['review'], status: 'proposed' }),
      entry({ id: 'a1', appliesTo: ['*'] }),
    ]
    expect(filterNotes(tasks, { ...live, tasks: ['port'] }).map((e) => e.id)).toEqual(['p1', 'a1'])
    expect(noteSections(tasks, 'status').map((s) => [s.label, s.entries.map((e) => e.id)])).toEqual(
      [
        ['Waiting for review', ['r1']],
        ['Accepted', ['p1', 'a1']],
      ],
    )
  })

  test('totals count live notes of the space', () => {
    const repo = { kind: 'repo' as const, repo: { forge: 'w', path: 'shapes/circle' } }
    expect(noteTotals(list, { kind: 'all' })).toEqual({
      accepted: 2,
      proposed: 2,
      inherited: 0,
      shared: 1,
    })
    expect(noteTotals(list, repo).inherited).toBe(4)
  })

  test('ids and links', () => {
    expect(kbId('0123456789ab')).toBe('kb:0123456789ab')
    expect(kbId('0123456789ab', true)).toBe('kb:01234567')
    expect(noteLink('https://hk.test', 'a b')).toBe('https://hk.test/knowledge/notes?note=a%20b')
  })
})

const revision = (
  version: number,
  overrides: Partial<KnowledgeRevision> = {},
): KnowledgeRevision => {
  const {
    id: _id,
    source: _source,
    author: _author,
    createdAt: _c,
    updatedAt: _u,
    version: _v,
    ...content
  } = entry()
  return {
    ...content,
    version,
    editedBy: `u${version}`,
    editedAt: `2026-10-0${version}T00:00:00.000Z`,
    ...overrides,
  }
}

describe('note history', () => {
  test('lists the current version first with what each version changed', () => {
    const current = entry({ title: 'Use the shiny facade', updatedBy: 'u9', version: 3 })
    const rows = noteVersions(current, [revision(1, { body: 'First text.' }), revision(2)])
    expect(rows.map((row) => [row.version, row.by, row.changed, row.current])).toEqual([
      [3, 'u9', ['title'], true],
      [2, 'u2', ['text'], false],
      [1, 'u1', [], false],
    ])
  })

  test('changed fields follow form order', () => {
    expect(
      changedFields(revision(1), revision(2, { topics: ['x'], title: 'New', status: 'proposed' })),
    ).toEqual(['title', 'topics', 'status'])
  })

  test('restoring sends the old content guarded by the current version', () => {
    const current = entry({ version: 5, title: 'Now' })
    expect(restoreInput(current, revision(2, { title: 'Then', visibility: 'shared' }))).toEqual({
      title: 'Then',
      body: 'Never import the engine.',
      kind: 'convention',
      scope: { groups: ['games'] },
      topics: ['style'],
      appliesTo: ['review'],
      visibility: 'shared',
      evidence: [],
      version: 5,
    })
  })
})
