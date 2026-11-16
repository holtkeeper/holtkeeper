import { describe, expect, test } from 'bun:test'

import type { CommitQuery, CommitRecord, MergeRequestRecord } from '@holtkeeper/forge'

import { readRepoHistory } from './read.ts'

const repo = { forge: 'work', path: 'acme/web' }

function fakeForge() {
  const commits = new Map<string, CommitRecord>()
  const branches = new Map<string, string>()
  const mergeRequests: MergeRequestRecord[] = []
  const calls: string[] = []
  let minute = 0
  const add = (branch: string, title: string, parents?: string[]) => {
    const sha = `s${commits.size + 1}`
    const head = branches.get(branch)
    commits.set(sha, {
      sha,
      parents: parents ?? (head ? [head] : []),
      authorName: 'Dev',
      authorEmail: 'dev@example.com',
      authoredAt: new Date(Date.UTC(2026, 9, 1, 0, ++minute)).toISOString(),
      title,
      message: title,
    })
    branches.set(branch, sha)
    return sha
  }
  const reachable = (sha: string | undefined) => {
    const found = new Set<string>()
    const queue = sha ? [sha] : []
    while (queue.length) {
      const next = queue.pop()!
      if (found.has(next) || !commits.has(next)) continue
      found.add(next)
      queue.push(...commits.get(next)!.parents)
    }
    return found
  }
  const forge = {
    async listCommits(_repo: string, query: CommitQuery) {
      calls.push(
        `commits ${query.ref}${query.since ? ` since ${query.since}` : ''}${query.after ? ' after' : ''}`,
      )
      const head = branches.get(query.ref) ?? (commits.has(query.ref) ? query.ref : undefined)
      if (!head) throw new Error('404 ref')
      const excluded = reachable(query.since)
      return [...reachable(head)]
        .filter((sha) => !excluded.has(sha))
        .map((sha) => commits.get(sha)!)
        .filter((commit) => !query.after || commit.authoredAt >= query.after)
        .toSorted((a, b) => b.authoredAt.localeCompare(a.authoredAt))
        .slice(0, query.limit)
    },
    async listMergeRequests(_repo: string, query: { state?: string } = {}) {
      calls.push(`mrs ${query.state}`)
      return mergeRequests.filter((mr) => mr.state === query.state)
    },
    async listMergeRequestCommits(_repo: string, id: number) {
      calls.push(`mr commits ${id}`)
      return id === 1 ? ['s2'] : []
    },
  }
  return { forge, add, branches, commits, mergeRequests, calls }
}

const since = '2026-01-01T00:00:00.000Z'

describe('readRepoHistory', () => {
  test('reads once in full, then only what is new, and again when a branch is rewritten', async () => {
    const fake = fakeForge()
    fake.add('main', 'chore: start')
    fake.add('main', 'feat: ABC-1 fast forward')
    fake.mergeRequests.push({
      id: 1,
      title: 'ABC-1 Fast forward',
      description: '',
      sourceBranch: 'feature/a',
      targetBranch: 'main',
      state: 'merged',
      draft: false,
      labels: [],
      author: 'dev',
      webUrl: 'https://forge.example/mr/1',
      createdAt: since,
      updatedAt: '2026-10-01T00:00:00.000Z',
      mergedAt: '2026-10-01T00:00:00.000Z',
      headSha: 's2',
    })
    const options = {
      forge: fake.forge,
      repo,
      defaultBranch: 'main',
      branches: ['main', 'missing'],
      since,
    }
    const first = await readRepoHistory({ ...options, now: new Date('2026-10-02') })
    expect(
      first.branches.map((branch) => [branch.branch, branch.head, branch.commits.length]),
    ).toEqual([['main', 's2', 2]])
    expect(first.mergeRequests[0]?.commits).toEqual(['s2'])

    fake.calls.length = 0
    const same = await readRepoHistory({ ...options, now: new Date('2026-10-03'), previous: first })
    expect(fake.calls).toEqual(['commits main', 'commits missing', 'mrs merged', 'mrs open'])
    expect(same.mergeRequests[0]?.commits).toEqual(['s2'])

    fake.add('main', 'fix: ABC-2 next')
    fake.calls.length = 0
    const next = await readRepoHistory({ ...options, now: new Date('2026-10-04'), previous: same })
    expect(fake.calls).toContain('commits s3 since s2')
    expect(next.branches[0]?.commits.map((commit) => commit.sha)).toEqual(['s3', 's2', 's1'])

    // Rewrite main: a new history that does not continue the old head.
    fake.branches.set('main', 's1')
    fake.add('main', 'feat: rewritten')
    fake.calls.length = 0
    const rewritten = await readRepoHistory({
      ...options,
      now: new Date('2026-10-05'),
      previous: next,
    })
    expect(fake.calls).toContain('commits s4 after')
    expect(rewritten.branches[0]?.commits.map((commit) => commit.sha)).toEqual(['s4', 's1'])
  })
})
