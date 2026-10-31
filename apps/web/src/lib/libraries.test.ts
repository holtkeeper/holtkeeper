import { describe, expect, test } from 'bun:test'

import {
  excerpt,
  formatRoles,
  groupDocuments,
  headingPath,
  httpUrl,
  libraryListQuery,
  librarySearchQuery,
  parseEcosystem,
  runSummary,
  sortedSources,
  sourceLabel,
  toneOfStatus,
} from './libraries.ts'

describe('queries', () => {
  test('list query drops blanks and "all"', () => {
    expect(libraryListQuery({ q: '  ', ecosystem: 'all' })).toEqual({})
    expect(libraryListQuery({ q: ' react ', ecosystem: 'npm' })).toEqual({
      q: 'react',
      ecosystem: 'npm',
    })
  })

  test('search query keeps only given filters', () => {
    expect(librarySearchQuery({ q: ' useState ' })).toEqual({ q: 'useState' })
    expect(
      librarySearchQuery({
        q: 'x',
        ecosystem: 'Go',
        name: 'github.com/a/b',
        version: 'v1.2.0',
        limit: 30,
      }),
    ).toEqual({ q: 'x', ecosystem: 'Go', name: 'github.com/a/b', version: 'v1.2.0', limit: 30 })
  })

  test('parses ecosystems from URL values', () => {
    expect(parseEcosystem('npm')).toBe('npm')
    expect(parseEcosystem('Go')).toBe('Go')
    expect(parseEcosystem('go')).toBeUndefined()
    expect(parseEcosystem(3)).toBeUndefined()
  })
})

test('orders roles and keeps only present ones', () => {
  expect(formatRoles(['patch', 'used', 'latest']).map((r) => r.label)).toEqual([
    'used',
    'latest',
    'newest patch',
  ])
  expect(formatRoles([])).toEqual([])
})

test('sorts sources in fetch order with labels and tones', () => {
  const at = '2026-10-01T00:00:00Z'
  const list = sortedSources({
    releases: { status: 'failed', at, message: 'rate limited' },
    archive: { status: 'ok', at },
  })
  expect(list.map((s) => [s.kind, s.label])).toEqual([
    ['archive', 'Package archive'],
    ['releases', 'Releases'],
  ])
  expect(toneOfStatus('failed')).toBe('danger')
  expect(toneOfStatus('ok')).toBe('success')
  expect(sourceLabel('unknown')).toBe('unknown')
})

test('groups documents by source in fetch order', () => {
  const groups = groupDocuments([
    { source: 'releases', path: 'v2.0.0', chunks: 1 },
    { source: 'archive', path: 'README.md', chunks: 4 },
    { source: 'archive', path: 'CHANGELOG.md', chunks: 9 },
  ])
  expect(groups.map((g) => [g.source, g.documents.map((d) => d.path)])).toEqual([
    ['archive', ['CHANGELOG.md', 'README.md']],
    ['releases', ['v2.0.0']],
  ])
})

describe('excerpt', () => {
  test('strips markdown and markup to plain text', () => {
    expect(
      excerpt(
        '## Install\n\nRun **npm i** [react](https://x.dev) <img src=x onerror=alert(1)>\n\n```sh\nnpm i\n```\n- `item`',
      ),
    ).toBe('Install Run npm i react item')
  })

  test('cuts long text at a word boundary', () => {
    const text = 'word '.repeat(100)
    const short = excerpt(text, 50)
    expect(short.endsWith('…')).toBe(true)
    expect(short.length).toBeLessThanOrEqual(51)
    expect(short).not.toContain('wor…')
  })
})

test('heading path and http-only links', () => {
  expect(headingPath(['Guide', 'Install'])).toBe('Guide › Install')
  expect(httpUrl('https://github.com/a/b')).toBe('https://github.com/a/b')
  expect(httpUrl('javascript:alert(1)')).toBeUndefined()
  expect(httpUrl('/relative')).toBeUndefined()
  expect(httpUrl(undefined)).toBeUndefined()
})

test('summarizes a run', () => {
  expect(
    runSummary({
      startedAt: '2026-10-01T00:00:00Z',
      finishedAt: '2026-10-01T00:02:00Z',
      libraries: 12,
      versionsAdded: 5,
      versionsRemoved: 1,
      librariesRemoved: 0,
      failures: [{ library: 'npm:x', source: 'archive', message: 'boom' }],
    }),
  ).toBe('12 libraries · 5 versions added · 1 removed · 1 failure · took 2 min')
})
