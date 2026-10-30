import { describe, expect, test } from 'bun:test'

import { groupCommits, normalizeMessage, sectionOf } from './group.ts'
import { parseCommit } from './parse.ts'
import type { ChangelogCommit } from './types.ts'

let clock = Date.parse('2026-10-01T10:00:00Z')

function commit(
  subject: string,
  options: { body?: string; author?: string; parents?: number; files?: number } = {},
): ChangelogCommit {
  clock += 3_600_000
  const author = options.author ?? 'Ann'
  const sha = Bun.hash(subject + clock)
    .toString(16)
    .padStart(16, '0')
    .repeat(3)
    .slice(0, 40)
  const parents = Array.from({ length: options.parents ?? 1 }, (_, i) => `${i}`.repeat(40))
  return {
    sha,
    parents,
    author: { name: author, email: `${author.toLowerCase()}@example.com` },
    date: new Date(clock).toISOString(),
    subject,
    body: options.body ?? '',
    stats: { files: options.files ?? 1, insertions: 10, deletions: 2 },
    parsed: parseCommit(subject, options.body),
  }
}

describe('normalizeMessage', () => {
  test.each([
    ['Retry upload.', 'retry upload'],
    ['  retry   upload!! ', 'retry upload'],
    ['[GTW-435] Retry upload', 'retry upload'],
    ['retry upload (#12)', 'retry upload'],
    ['retry upload !12', 'retry upload'],
    ['WIP: retry upload', 'retry upload'],
    ['fixup! squash! retry upload', 'retry upload'],
    ['Повторять ЗАГРУЗКУ…', 'повторять загрузку'],
  ])('%p → %p', (input, expected) => {
    expect(normalizeMessage(input)).toBe(expected)
  })
})

describe('groupCommits', () => {
  const commits = [
    commit('feat: [GTW-435] add passkeys', { author: 'Ann' }),
    commit('fix(upload): retry upload', { author: 'Bob' }),
    commit('fix(upload): Retry upload.', { author: 'Ann' }),
    commit('fix(upload): [GTW-500] retry upload', { author: 'Bob' }),
    commit('fixup! fix(upload): retry upload', { author: 'Bob' }),
    commit('fix: retry upload', { author: 'Ann' }),
    commit('feat(api)!: drop v1 endpoints', { body: 'BREAKING CHANGE: v1 is gone' }),
    commit('docs: Обновил README'),
    commit('docs: обновил readme'),
    commit('ci: cache bun install'),
    commit('Поправил опечатку', {
      author: 'Ivan',
      body: 'Co-authored-by: Ann <ann@example.com>',
    }),
    commit('Revert "feat: new cache"', { body: 'This reverts commit abcdef1234567.' }),
    commit("Merge branch 'fix-upload' into 'main'", {
      parents: 2,
      body: 'fix: retry upload\n\nSee merge request games/slots!42',
    }),
    commit("Merge branch 'docs' into 'main'", {
      parents: 2,
      body: 'See merge request games/slots!43',
    }),
    commit("Merge branch 'docs' into 'main'", {
      parents: 2,
      body: 'See merge request games/slots!44',
    }),
  ]
  const groups = groupCommits(commits)

  test('sections follow the fixed order', () => {
    expect(groups.sections.map((section) => section.id)).toEqual([
      'breaking',
      'features',
      'fixes',
      'reverts',
      'docs',
      'build',
      'other',
    ])
  })

  test('identical messages collapse per scope', () => {
    const fixes = groups.sections.find((section) => section.id === 'fixes')!
    expect(fixes.scopes.map((scope) => scope.scope)).toEqual(['upload', undefined])
    const upload = fixes.scopes[0]!.clusters
    expect(upload).toHaveLength(1)
    expect(upload[0]!.commits).toHaveLength(4)
    expect(upload[0]!.tickets).toEqual(['GTW-500'])
    expect(upload[0]!.authors.toSorted()).toEqual(['Ann', 'Bob'])
    expect(fixes.scopes[1]!.clusters[0]!.commits).toHaveLength(1)
  })

  test('collapses Cyrillic messages regardless of case', () => {
    const docs = groups.sections.find((section) => section.id === 'docs')!
    expect(docs.scopes[0]!.clusters).toHaveLength(1)
    expect(docs.scopes[0]!.clusters[0]!.title).toBe('обновил readme')
  })

  test('breaking changes leave their type section', () => {
    expect(sectionOf(commits[6]!)).toBe('breaking')
    const features = groups.sections.find((section) => section.id === 'features')!
    expect(features.scopes.flatMap((scope) => scope.clusters)).toHaveLength(1)
  })

  test('merge commits are collapsed separately', () => {
    expect(groups.merges.map((cluster) => cluster.commits.length)).toEqual([2, 1])
    expect(groups.mergeRequests.map((request) => request.number)).toEqual([44, 43, 42])
  })

  test('contributors count authored and co-authored commits', () => {
    const ann = groups.contributors.find((person) => person.name === 'Ann')!
    expect(ann).toMatchObject({ coAuthored: 1 })
    expect(groups.contributors.map((person) => person.name)).toContain('Ivan')
    expect(groups.contributors[0]!.commits).toBeGreaterThanOrEqual(groups.contributors[1]!.commits)
  })

  test('tickets list every mention', () => {
    expect(groups.tickets.map((ticket) => ticket.id).toSorted()).toEqual(['GTW-435', 'GTW-500'])
  })
})
