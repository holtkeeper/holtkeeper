import { describe, expect, test } from 'bun:test'

import { changesOf, cleanTitle, mergedBranchOf } from './changes.ts'
import type { QaCommit, QaMergeRequest, QaRepoHistory } from './model.ts'

const repo = { forge: 'work', path: 'acme/shop' }
let minute = 0
const at = () => new Date(Date.UTC(2026, 9, 1, 0, ++minute)).toISOString()

const commit = (sha: string, parents: string[], title: string, body = ''): QaCommit => ({
  sha,
  parents,
  title,
  message: body ? `${title}\n\n${body}` : title,
  author: `Dev ${sha}`,
  at: at(),
})

const mr = (
  id: number,
  title: string,
  extra: Partial<QaMergeRequest> & Pick<QaMergeRequest, 'sourceBranch'>,
): QaMergeRequest => ({
  id,
  title,
  description: '',
  targetBranch: 'development',
  state: 'merged',
  draft: false,
  author: 'dev',
  url: `https://forge.example/acme/shop/-/merge_requests/${id}`,
  updatedAt: at(),
  ...extra,
})

function history(): QaRepoHistory {
  // development, oldest first: a direct commit, a merge commit of !5 with two branch commits,
  // a squash commit of !6, two fast-forwarded commits of !7, a local merge with one commit.
  const dev = [
    commit('base', [], 'chore: start'),
    commit('c1', ['base'], 'fix: ABC-1 typo on the widget page'),
    commit('f1', ['c1'], 'feat: widget panel'),
    commit('f2', ['f1'], 'test: widget panel'),
    commit('m5', ['c1', 'f2'], "Merge branch 'feature/ABC-2-widget' into 'development'"),
    commit('s6', ['m5'], 'ABC-3 Shape base'),
    commit('ff1', ['s6'], 'feat: one part'),
    commit('ff2', ['ff1'], 'feat: other part'),
    commit('x1', ['ff2'], 'fix: inner'),
    commit('lm', ['ff2', 'x1'], "Merge branch 'feature/ABC-5-local' into 'development'"),
  ]
  const main = [
    commit('r8', ['base', 'lm'], "Merge branch 'development' into 'main'"),
    commit('h9', ['r8'], 'fix: ABC-6 crash on start'),
  ]
  return {
    repo,
    readAt: at(),
    since: '2026-01-01T00:00:00.000Z',
    defaultBranch: 'main',
    branches: [
      { branch: 'development', head: 'lm', capped: false, commits: dev.toReversed() },
      {
        branch: 'main',
        head: 'h9',
        capped: false,
        commits: [...main, ...dev].toReversed(),
      },
    ],
    mergeRequests: [
      mr(5, 'feat: ABC-2 Widget panel', {
        sourceBranch: 'feature/ABC-2-widget',
        mergeCommitSha: 'm5',
        mergedAt: '2026-10-01T00:05:00.000Z',
        headSha: 'f2',
      }),
      mr(6, 'ABC-3 Shape base', { sourceBranch: 'feature/shape', squashCommitSha: 's6' }),
      mr(7, 'feat(ui): [ABC-4] Two parts', {
        sourceBranch: 'feature/two',
        headSha: 'ff2',
        commits: ['ff2', 'ff1'],
      }),
      mr(8, 'Release candidate', {
        sourceBranch: 'development',
        targetBranch: 'main',
        mergeCommitSha: 'r8',
      }),
      mr(9, 'fix: ABC-6 crash on start', {
        sourceBranch: 'hotfix/crash',
        targetBranch: 'main',
        squashCommitSha: 'h9',
      }),
      mr(10, 'Draft: ABC-7 Foo widget', {
        sourceBranch: 'feature/ABC-7',
        state: 'open',
        draft: true,
        headSha: 'o1',
      }),
      mr(11, 'Release candidate', {
        sourceBranch: 'development',
        targetBranch: 'main',
        state: 'open',
        headSha: 'lm',
      }),
    ],
  }
}

describe('changesOf', () => {
  test('attributes every landing to a merge request, a local merge or a direct commit', () => {
    const changes = changesOf(history())
    const byId = Object.fromEntries(changes.map((change) => [change.id, change]))
    expect(
      changes
        .map((change) => [change.id, change.kind, change.branch, change.keys])
        .toSorted((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ['!10', 'open-merge-request', 'development', ['ABC-7']],
      ['!5', 'merge-request', 'development', ['ABC-2']],
      ['!6', 'merge-request', 'development', ['ABC-3']],
      ['!7', 'merge-request', 'development', ['ABC-4']],
      ['!9', 'merge-request', 'main', ['ABC-6']],
      ['base', 'commit', 'development', []],
      ['c1', 'commit', 'development', ['ABC-1']],
      ['lm', 'merge', 'development', ['ABC-5']],
    ])
    expect(byId['!5']).toMatchObject({
      title: 'Widget panel',
      commits: ['m5', 'f2', 'f1'],
      base: 'c1',
      head: 'm5',
      at: '2026-10-01T00:05:00.000Z',
    })
    expect(byId['!7']).toMatchObject({
      title: 'Two parts',
      commits: ['ff2', 'ff1'],
      base: 's6',
      head: 'ff2',
    })
    expect(byId['lm']).toMatchObject({ title: 'inner', commits: ['lm', 'x1'], base: 'ff2' })
    expect(byId['c1']?.mergeRequest).toBeUndefined()
    expect(byId['!10']).toMatchObject({ head: 'o1', title: 'Foo widget' })
    expect(changes.map((change) => change.at)).toEqual(
      changes
        .map((change) => change.at)
        .toSorted()
        .toReversed(),
    )
  })

  test('a commit already part of a change on an earlier branch is not counted again', () => {
    const changes = changesOf(history())
    const owners = changes.flatMap((change) => change.commits)
    expect(owners.length).toBe(new Set(owners).size)
    expect(changes.some((change) => change.id === '!8')).toBe(false)
  })
})

describe('titles', () => {
  test('cleanTitle drops types, scopes and ticket keys', () => {
    expect(cleanTitle('feat(ui): [ABC-1] Widget panel')).toBe('Widget panel')
    expect(cleanTitle('ABC-12: Shape base')).toBe('Shape base')
    expect(cleanTitle('fix: crash on start (ABC-3)')).toBe('crash on start')
    expect(cleanTitle('Plain words')).toBe('Plain words')
  })

  test('mergedBranchOf reads local, remote and pull request merges', () => {
    expect(mergedBranchOf("Merge branch 'feature/x' into 'development'")).toBe('feature/x')
    expect(mergedBranchOf("Merge remote-tracking branch 'origin/development'")).toBe('development')
    expect(mergedBranchOf('Merge pull request #4 from someone/feature/y')).toBe('feature/y')
    expect(mergedBranchOf('feat: no merge')).toBeUndefined()
  })
})
