import { describe, expect, test } from 'bun:test'

import { createFakeRunner } from '@holtkeeper/exec/testing'

import { analyzeChangelog, maxChangedFiles } from './analyze.ts'
import { gitHistory, parseChangedFiles, parseShortStat, sortRefs } from './git.ts'
import { forgeLinks } from './links.ts'
import { compareVersions } from './version.ts'

const RS = '\u001e'
const US = '\u001f'

const tag = (...fields: string[]) => `${fields.join(US)}${RS}\n`

describe('gitHistory', () => {
  test('parses log records with stats and multi-line bodies', async () => {
    const stdout = [
      `${RS}${'a'.repeat(40)}${US}${'b'.repeat(40)}${US}Ann${US}ann@x.test${US}2026-10-02T10:00:00+03:00${US}feat: one${US}Body line\n\nCo-authored-by: Bob <bob@x.test>\n${US}\n\n 2 files changed, 5 insertions(+), 1 deletion(-)\n`,
      `${RS}${'c'.repeat(40)}${US}${'d'.repeat(40)} ${'e'.repeat(40)}${US}Bob${US}bob@x.test${US}2026-10-01T10:00:00Z${US}Merge branch 'x'${US}${US}\n`,
    ].join('')
    const { runner, calls } = createFakeRunner(() => ({ stdout }))
    const commits = await gitHistory({ runner }).commits('/repo', { from: 'v1', to: 'v2' })
    expect(calls[0]!.command).toContain('v1..v2')
    expect(calls[0]!.options.cwd).toBe('/repo')
    expect(commits).toHaveLength(2)
    expect(commits[0]).toMatchObject({
      author: { name: 'Ann', email: 'ann@x.test' },
      subject: 'feat: one',
      body: 'Body line\n\nCo-authored-by: Bob <bob@x.test>',
      stats: { files: 2, insertions: 5, deletions: 1 },
    })
    expect(commits[1]!.parents).toHaveLength(2)
    expect(commits[1]!.stats).toEqual({ files: 0, insertions: 0, deletions: 0 })
  })

  test('lists annotated and lightweight tags newest version first', async () => {
    const stdout = [
      tag('v1.10.0', 'commit', 'a'.repeat(40), '', '2026-09-01T00:00:00Z', 'commit message'),
      tag('v1.9.0', 'tag', 't'.repeat(40), 'b'.repeat(40), '2026-10-01T00:00:00Z', 'Release 1.9\n'),
      tag('v2.0.0-rc.1', 'tag', 'u'.repeat(40), 'c'.repeat(40), '2026-08-01T00:00:00Z', ''),
    ].join('')
    const { runner } = createFakeRunner(() => ({ stdout }))
    const refs = await gitHistory({ runner }).listRefs('/repo')
    expect(refs.map((ref) => ref.name)).toEqual(['v2.0.0-rc.1', 'v1.10.0', 'v1.9.0'])
    expect(refs[1]!.message).toBeUndefined()
    expect(refs[2]).toMatchObject({ sha: 'b'.repeat(40), message: 'Release 1.9' })
  })

  test('throws when git fails', async () => {
    const { runner } = createFakeRunner(() => ({ exitCode: 128, stderr: 'not a git repository' }))
    const error = await gitHistory({ runner })
      .listRefs('/repo')
      .catch((caught: unknown) => caught)
    expect(String(error)).toContain('not a git repository')
  })
})

test('sortRefs falls back to dates for non-version names', () => {
  const refs = sortRefs([
    { name: 'release-a', sha: '1', date: '2026-01-01T00:00:00Z' },
    { name: 'v1.0.0', sha: '2', date: '2026-03-01T00:00:00Z' },
    { name: 'release-b', sha: '3', date: '2026-02-01T00:00:00Z' },
  ])
  expect(refs.map((ref) => ref.name)).toEqual(['v1.0.0', 'release-b', 'release-a'])
})

test('compareVersions follows semver precedence', () => {
  const sorted = ['1.0.0', 'v1.0.0-rc.10', '1.0.0-rc.2', '1.0.0-alpha', '0.9.9', '1.0.0-alpha.1']
  sorted.sort(compareVersions)
  expect(sorted).toEqual([
    '0.9.9',
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-rc.2',
    'v1.0.0-rc.10',
    '1.0.0',
  ])
})

test('parseShortStat', () => {
  expect(parseShortStat(' 1 file changed, 3 insertions(+)')).toEqual({
    files: 1,
    insertions: 3,
    deletions: 0,
  })
})

describe('forgeLinks', () => {
  test('gitlab', () => {
    const links = forgeLinks({
      kind: 'gitlab',
      webUrl: 'https://gitlab.example.com/games/slots/',
      ticketUrl: 'https://jira.example.com/browse/{id}',
    })
    expect(links.commit('abc')).toBe('https://gitlab.example.com/games/slots/-/commit/abc')
    expect(links.compare('v1.0.0', 'v1.1.0')).toBe(
      'https://gitlab.example.com/games/slots/-/compare/v1.0.0...v1.1.0',
    )
    expect(links.mergeRequest(12)).toBe(
      'https://gitlab.example.com/games/slots/-/merge_requests/12',
    )
    expect(links.tag('v1.1.0')).toBe('https://gitlab.example.com/games/slots/-/tags/v1.1.0')
    expect(links.ticket('GTW-435')).toBe('https://jira.example.com/browse/GTW-435')
    expect(links.ticket('#5')).toBe('https://gitlab.example.com/games/slots/-/issues/5')
  })

  test('github', () => {
    const links = forgeLinks({ kind: 'github', webUrl: 'https://github.com/o/r' })
    expect(links.commit('abc')).toBe('https://github.com/o/r/commit/abc')
    expect(links.compare('a', 'b')).toBe('https://github.com/o/r/compare/a...b')
    expect(links.mergeRequest(3)).toBe('https://github.com/o/r/pull/3')
    expect(links.ticket('GTW-1')).toBeUndefined()
  })
})

describe('changed files', () => {
  const numstat = [
    '3\t1\tsrc/a.ts',
    '0\t0\t',
    'old/b.ts',
    'new/b.ts',
    '-\t-\tlogo.png',
    '0\t9\tgone.ts',
    '',
  ].join('\0')
  const nameStatus = [
    'M',
    'src/a.ts',
    'R100',
    'old/b.ts',
    'new/b.ts',
    'A',
    'logo.png',
    'D',
    'gone.ts',
    '',
  ].join('\0')

  test('joins numstat and name-status output', () => {
    expect(parseChangedFiles(numstat, nameStatus)).toEqual([
      { path: 'src/a.ts', insertions: 3, deletions: 1, status: 'modified' },
      {
        path: 'new/b.ts',
        insertions: 0,
        deletions: 0,
        previousPath: 'old/b.ts',
        status: 'renamed',
      },
      { path: 'logo.png', insertions: 0, deletions: 0, binary: true, status: 'added' },
      { path: 'gone.ts', insertions: 0, deletions: 9, status: 'deleted' },
    ])
  })

  test('gitHistory diffs the range with rename detection', async () => {
    const { runner, calls } = createFakeRunner((command) => ({
      stdout: command.includes('--numstat')
        ? numstat
        : command.includes('--name-status')
          ? nameStatus
          : '',
    }))
    const files = await gitHistory({ runner }).changedFiles!('/repo', { from: 'v1', to: 'v2' })
    expect(files).toHaveLength(4)
    for (const call of calls)
      expect(call.command).toEqual(expect.arrayContaining(['-z', '-M', 'v1', 'v2']))
  })

  test('analyzeChangelog keeps the most changed files and flags truncation', async () => {
    const many = Array.from({ length: maxChangedFiles + 2 }, (_, i) => ({
      path: `f${i}.ts`,
      insertions: i,
      deletions: 0,
    }))
    const ref = { name: 'v2', sha: 'b'.repeat(40), date: '2026-10-02T00:00:00Z' }
    const data = await analyzeChangelog({
      dir: '/repo',
      to: 'v2',
      from: 'v1',
      history: {
        listRefs: async () => [],
        resolve: async (_dir, name) => ({ ...ref, name }),
        commits: async () => [],
        changedFiles: async () => many,
      },
    })
    expect(data.files).toHaveLength(maxChangedFiles)
    expect(data.files![0]!.path).toBe(`f${maxChangedFiles + 1}.ts`)
    expect(data.filesTruncated).toBe(true)
  })
})
