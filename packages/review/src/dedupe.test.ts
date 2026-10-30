import { describe, expect, test } from 'bun:test'

import type { Discussion } from '@holtkeeper/forge'

import { dedupe, findingMarker, markerOf, openThreads, rankAndCap, similarity } from './dedupe.ts'
import type { Candidate } from './validate.ts'

const candidate = (extra: Partial<Candidate>): Candidate => ({
  path: 'a.ts',
  line: 10,
  severity: 'minor',
  category: 'bug',
  title: 'Null check missing',
  body: 'The user lookup may return undefined and the access crashes.',
  source: 'agent',
  ...extra,
})

const discussion = (id: string, body: string, extra: Partial<Discussion> = {}): Discussion => ({
  id,
  resolvable: true,
  resolved: false,
  notes: [{ id: 1, author: 'someone', body, createdAt: '', system: false }],
  position: { path: 'a.ts', line: 11, side: 'new', headSha: 'x' },
  ...extra,
})

describe('markers and threads', () => {
  test('markerOf reads finding ids', () => {
    expect(markerOf(`hi\n\n${findingMarker('abc')}`)).toBe('abc')
    expect(markerOf('<!-- holtkeeper:review summary head=1 -->')).toBe('')
    expect(markerOf('plain')).toBeUndefined()
  })

  test('openThreads keeps unresolved diff threads and recognizes ours', () => {
    const threads = openThreads(
      [
        discussion('1', `Bug here ${findingMarker('f1')}`),
        discussion('2', 'Bot note', {
          notes: [{ id: 2, author: 'holtkeeper-bot', body: 'x', createdAt: '', system: false }],
        }),
        discussion('3', 'human'),
        discussion('4', 'resolved', { resolved: true }),
        { ...discussion('5', 'general'), position: undefined },
      ],
      'holtkeeper-bot',
    )
    expect(threads.map((t) => [t.discussionId, t.ours, t.findingId])).toEqual([
      ['1', true, 'f1'],
      ['2', true, undefined],
      ['3', false, undefined],
    ])
    expect(threads[0]?.text).toBe('Bug here')
  })
})

test('similarity is high for rephrasings and low for different topics', () => {
  expect(
    similarity(
      'Null check missing: the user lookup may return undefined',
      'User lookup may return undefined, add a null check',
    ),
  ).toBeGreaterThan(0.45)
  expect(
    similarity('Use a constant for the timeout', 'SQL injection in the query builder'),
  ).toBeLessThan(0.2)
})

describe('dedupe', () => {
  test('separates repeats of open threads, duplicates and new findings', () => {
    const [thread] = openThreads([
      discussion('t', 'Null check missing: the user lookup may return undefined and crash.'),
    ])
    const lint = candidate({
      line: 30,
      category: 'maintainability',
      title: 'oxlint: no-unused-vars',
      body: 'x is unused',
      source: 'oxlint',
    })
    const result = dedupe(
      [
        candidate({}),
        candidate({ line: 30, category: 'maintainability', title: 'Unused', body: 'remove it' }),
        candidate({ line: 50, title: 'Race', body: 'Two writers race on the cache entry.' }),
        candidate({
          line: 51,
          title: 'Race condition',
          body: 'Two writers race on the cache entry here.',
        }),
      ],
      { threads: thread ? [thread] : [], deterministic: [lint] },
    )
    expect(result.repeats.map((r) => r.thread.discussionId)).toEqual(['t'])
    expect(result.duplicates.map((c) => c.line)).toEqual([30, 51])
    expect(result.kept.map((c) => c.line)).toEqual([50])
  })
})

test('rankAndCap filters by severity, sorts and caps', () => {
  const list = [
    candidate({ severity: 'info', line: 1 }),
    candidate({ severity: 'minor', category: 'style', line: 2 }),
    candidate({ severity: 'critical', category: 'security', line: 3 }),
    candidate({ severity: 'minor', category: 'bug', line: 4 }),
    candidate({ severity: 'major', line: 5 }),
  ]
  const result = rankAndCap(list, 'minor', 3)
  expect(result.kept.map((c) => c.line)).toEqual([3, 5, 4])
  expect(result.belowSeverity).toBe(1)
  expect(result.overLimit).toBe(1)
})
