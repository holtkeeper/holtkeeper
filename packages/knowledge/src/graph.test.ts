import { describe, expect, test } from 'bun:test'

import type { KnowledgeEntry } from '@holtkeeper/store'

import { knowledgeChapters, knowledgeLinks, linkIndex } from './graph.ts'
import { pullRelated } from './select.ts'

const entry = (id: string, extra: Partial<KnowledgeEntry> = {}): KnowledgeEntry => ({
  id,
  title: `Entry ${id}`,
  body: 'Text.',
  kind: 'convention',
  scope: { all: true },
  topics: [],
  appliesTo: ['*'],
  visibility: 'team',
  status: 'accepted',
  evidence: [],
  source: 'human',
  author: 'u1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  version: 1,
  ...extra,
})

describe('knowledgeLinks', () => {
  test('links supersedes, citations, subjects and shared topics once per pair', () => {
    const entries = [
      entry('aaaaaaaa', { supersedes: 'bbbbbbbb' }),
      entry('bbbbbbbb', { subject: 'npm:widget', topics: ['testing', 'ci'] }),
      entry('cccccccc', { body: 'See [kb:aaaaaaaa] first.', subject: 'npm:widget' }),
      entry('dddddddd', { topics: ['testing', 'ci', 'build'] }),
    ]
    const links = knowledgeLinks(entries)
    expect(links).toContainEqual({
      from: 'aaaaaaaa',
      to: 'bbbbbbbb',
      kind: 'supersedes',
      weight: 1,
    })
    expect(links).toContainEqual({ from: 'cccccccc', to: 'aaaaaaaa', kind: 'cites', weight: 0.9 })
    expect(links.find((l) => l.kind === 'subject')).toMatchObject({
      from: 'bbbbbbbb',
      to: 'cccccccc',
    })
    expect(links.find((l) => l.kind === 'topics')).toMatchObject({
      from: 'bbbbbbbb',
      to: 'dddddddd',
    })
    const pairs = links.map((l) => [l.from, l.to].toSorted().join())
    expect(new Set(pairs).size).toBe(pairs.length)
  })

  test('a citation by full UUID links', () => {
    const id = '1a2b3c4d-0000-4000-8000-000000000001'
    const links = knowledgeLinks([entry(id), entry('ffffffff-1', { body: `Per [kb:${id}].` })])
    expect(links).toEqual([{ from: 'ffffffff-1', to: id, kind: 'cites', weight: 0.9 }])
  })

  test('an ambiguous or unknown citation links nothing', () => {
    const entries = [
      entry('abcdef01', { body: '[kb:abcdef]' }),
      entry('abcdef02'),
      entry('abcdef03', { body: '[kb:ffffff]' }),
    ]
    expect(knowledgeLinks(entries)).toEqual([])
  })

  test('vectors add similar links above the threshold only', () => {
    const entries = [entry('a1'), entry('b1'), entry('c1')]
    const vectors = new Map([
      ['a1', Float32Array.from([1, 0])],
      ['b1', Float32Array.from([0.99, 0.1])],
      ['c1', Float32Array.from([0, 1])],
    ])
    const links = knowledgeLinks(entries, vectors)
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({ from: 'a1', to: 'b1', kind: 'similar' })
  })

  test('linkIndex lists both directions', () => {
    const index = linkIndex([{ from: 'a', to: 'b', kind: 'subject', weight: 0.7 }])
    expect(index.get('a')).toEqual(['b'])
    expect(index.get('b')).toEqual(['a'])
  })
})

describe('knowledgeChapters', () => {
  const entries = [
    entry('1', { subject: 'npm:widget', title: 'B' }),
    entry('2', { subject: 'npm:widget', title: 'A' }),
    entry('3', { subject: 'npm:lonely' }),
    entry('4', { topics: ['testing'], title: 'T1' }),
    entry('5', { topics: ['testing', 'ci'], title: 'T2' }),
    entry('6', { kind: 'quirk' }),
  ]

  test('groups by subject, then common topic, then kind; small chapters fold into their kind', () => {
    const chapters = knowledgeChapters(entries)
    expect(chapters.map((c) => [c.key, c.ids])).toEqual([
      ['topic:testing', ['4', '5']],
      ['subject:npm:widget', ['2', '1']],
      ['kind:convention', ['3']],
      ['kind:quirk', ['6']],
    ])
    expect(chapters[1]?.title).toBe('widget (npm)')
  })

  test('is stable for the same entries in any order', () => {
    expect(knowledgeChapters(entries.toReversed())).toEqual(knowledgeChapters(entries))
  })
})

describe('pullRelated', () => {
  test('moves entries linked to the best three right behind them', () => {
    const items = ['a', 'b', 'c', 'x', 'y', 'z'].map((id) => ({
      entry: entry(id, id === 'z' ? { subject: 's' } : id === 'a' ? { subject: 's' } : {}),
    }))
    expect(pullRelated(items).map((i) => i.entry.id)).toEqual(['a', 'b', 'c', 'z', 'x', 'y'])
  })
})
