import { describe, expect, test } from 'bun:test'

import type { Handbook, HandbookEntry } from '@holtkeeper/api'

import {
  graphScope,
  layoutIterations,
  filterHandbook,
  freshnessLine,
  handbookQuery,
  linkKindLabel,
  neighbourIds,
  relatedTo,
} from './handbook.ts'

const entry = (id: string, extra: Partial<HandbookEntry> = {}): HandbookEntry => ({
  id,
  title: `Title ${id}`,
  body: `Body of ${id}`,
  kind: 'decision',
  topics: [],
  scope: 'all repositories',
  repos: [],
  owner: [],
  updatedAt: '2026-01-01T00:00:00Z',
  version: 1,
  evidence: [],
  ...extra,
})

const stale = {
  status: 'stale' as const,
  checkedAt: '2026-01-01T00:00:00Z',
  method: 'signals' as const,
  repo: 'gl:acme/widget-kit',
  signals: [],
}

const book: Handbook = {
  chapters: [
    {
      key: 'topic:shapes',
      title: 'Shapes',
      entries: [
        entry('a', { topics: ['round'] }),
        entry('b', { freshness: stale, repos: ['gl:acme/widget-kit'] }),
      ],
    },
    { key: 'kind:quirk', title: 'Quirks', entries: [entry('c', { repos: ['gl:acme/other'] })] },
  ],
  links: [
    { from: 'a', to: 'b', kind: 'cites', weight: 0.4 },
    { from: 'c', to: 'a', kind: 'similar', weight: 0.9 },
    { from: 'b', to: 'c', kind: 'topics', weight: 0.2 },
  ],
  counts: { entries: 3, chapters: 2, suspect: 0, stale: 1 },
}

test('a space maps to the handbook query', () => {
  expect(handbookQuery({ kind: 'team', team: 'shapes' })).toEqual({ team: 'shapes' })
  expect(handbookQuery({ kind: 'repo', repo: { forge: 'gl', path: 'acme/widget-kit' } })).toEqual({
    repo: 'gl:acme/widget-kit',
  })
  expect(handbookQuery({ kind: 'all' })).toEqual({})
  expect(handbookQuery({ kind: 'family', family: 'f1' })).toEqual({})
})

test('text filter matches title, body and topics, and drops empty chapters and links', () => {
  const byTopic = filterHandbook(book, { text: 'ROUND' })
  expect(byTopic.chapters.map((c) => c.key)).toEqual(['topic:shapes'])
  expect(byTopic.links).toEqual([])
  expect(filterHandbook(book, { text: 'body of c' }).chapters[0]?.entries[0]?.id).toBe('c')
  expect(filterHandbook(book, { text: 'nothing here' }).chapters).toEqual([])
  expect(filterHandbook(book, {}).links).toHaveLength(3)
})

test('attention keeps suspect and stale entries only', () => {
  const view = filterHandbook(book, { attention: true })
  expect(view.chapters.flatMap((c) => c.entries.map((e) => e.id))).toEqual(['b'])
})

test('a family keeps entries of its repositories and entries that name none', () => {
  const view = filterHandbook(book, { members: ['gl:acme/widget-kit'] })
  expect(view.chapters.flatMap((c) => c.entries.map((e) => e.id))).toEqual(['a', 'b'])
})

test('related entries come strongest first with the direction', () => {
  expect(relatedTo(book.links, 'a')).toEqual([
    { id: 'c', kind: 'similar', outgoing: false, weight: 0.9 },
    { id: 'b', kind: 'cites', outgoing: true, weight: 0.4 },
  ])
  expect([...neighbourIds(book.links, 'a')].toSorted()).toEqual(['b', 'c'])
  expect(linkKindLabel('supersedes', false)).toBe('Superseded by')
})

test('freshness reads quietly when fresh and warns otherwise', () => {
  const now = new Date('2026-01-11T00:00:00Z')
  expect(freshnessLine({ ...stale, status: 'fresh' }, now)).toEqual({
    tone: 'default',
    text: 'Checked 10 days ago',
  })
  expect(freshnessLine({ ...stale, reason: 'file moved' }, now)).toEqual({
    tone: 'warning',
    text: 'Stale: file moved',
  })
})

describe('graphScope', () => {
  const links = [
    { from: 'a', to: 'b', kind: 'subject' as const, weight: 0.7 },
    { from: 'c', to: 'a', kind: 'cites' as const, weight: 0.9 },
  ]
  test('draws everything under the limit', () => {
    expect(graphScope(['a', 'b', 'c', 'd'], links, undefined, 10)).toEqual({
      ids: ['a', 'b', 'c', 'd'],
      local: false,
    })
  })
  test('over the limit draws the selected entry and its neighbours, or nothing', () => {
    expect(graphScope(['a', 'b', 'c', 'd'], links, undefined, 2)).toEqual({ ids: [], local: true })
    expect(graphScope(['a', 'b', 'c', 'd'], links, 'a', 2).ids).toEqual(['a', 'b'])
    expect(graphScope(['a', 'b', 'c', 'd'], links, 'a', 3).local).toBe(true)
  })
  test('layoutIterations shrinks for larger graphs within bounds', () => {
    expect(layoutIterations(10)).toBe(200)
    expect(layoutIterations(250)).toBe(160)
    expect(layoutIterations(5000)).toBe(40)
  })
})
