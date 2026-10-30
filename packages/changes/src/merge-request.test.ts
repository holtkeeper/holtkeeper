import { describe, expect, test } from 'bun:test'

import type { CommitInput, CreateMergeRequestInput, GitForge } from '@holtkeeper/forge'

import { openMergeRequest } from './merge-request.ts'
import type { CodeChange } from './types.ts'

function fakeForge(files: Record<string, string>) {
  const commits: CommitInput[] = []
  const requests: CreateMergeRequestInput[] = []
  const forge = {
    kind: 'fake',
    getRepository: async () => ({
      path: 'games/a',
      name: 'a',
      defaultBranch: 'main',
      webUrl: '',
      cloneUrl: '',
      archived: false,
    }),
    readFile: async (_repo: string, file: string) => files[file],
    commit: async (_repo: string, input: CommitInput) => {
      commits.push(input)
      return { sha: 'abc', webUrl: '' }
    },
    createMergeRequest: async (_repo: string, input: CreateMergeRequestInput) => {
      requests.push(input)
      return {
        id: 7,
        title: input.title,
        description: '',
        sourceBranch: input.sourceBranch,
        targetBranch: input.targetBranch,
        state: 'open' as const,
        draft: false,
        labels: [],
        author: 'bot',
        webUrl: 'https://forge.test/mr/7',
      }
    },
  }
  // Only the methods openMergeRequest uses are implemented.
  return { forge: forge as unknown as GitForge, commits, requests }
}

const change = (id: string, edits: CodeChange['edits']): CodeChange => ({
  id,
  title: `Change ${id}`,
  confidence: 'safe',
  source: 'test',
  edits,
})

describe('openMergeRequest', () => {
  test('commits applied changes to a new branch and opens a merge request', async () => {
    const { forge, commits, requests } = fakeForge({ 'a.ts': 'const x = 1\n' })
    const outcome = await openMergeRequest({
      forge,
      repo: 'games/a',
      title: 'Fix lint findings',
      changes: [
        change('one', [
          {
            kind: 'replace',
            file: 'a.ts',
            range: { start: { line: 1, column: 11 }, end: { line: 1, column: 12 } },
            oldText: '1',
            newText: '2',
          },
        ]),
        change('two', [{ kind: 'create', file: 'a.test.ts', newText: 'test\n' }]),
        change('stale', [
          {
            kind: 'replace',
            file: 'a.ts',
            range: { start: { line: 1, column: 1 }, end: { line: 1, column: 6 } },
            oldText: 'other',
            newText: 'let',
          },
        ]),
      ],
    })
    expect(outcome.plan.applied).toEqual(['one', 'two'])
    expect(outcome.plan.conflicts.map((c) => c.changeId)).toEqual(['stale'])
    expect(commits[0]).toMatchObject({
      startBranch: 'main',
      message: 'Fix lint findings',
      changes: [
        { action: 'update', path: 'a.ts', content: 'const x = 2\n' },
        { action: 'create', path: 'a.test.ts', content: 'test\n' },
      ],
    })
    expect(commits[0]?.branch).toStartWith('holtkeeper/fix-lint-findings-')
    expect(requests[0]).toMatchObject({
      targetBranch: 'main',
      labels: ['holtkeeper'],
      description: '- Change one\n- Change two',
    })
    expect(outcome.mergeRequest?.webUrl).toBe('https://forge.test/mr/7')
  })

  test('opens nothing when no change applies', async () => {
    const { forge, commits } = fakeForge({})
    const outcome = await openMergeRequest({
      forge,
      repo: 'games/a',
      title: 'x',
      changes: [change('gone', [{ kind: 'delete', file: 'a.ts', oldText: 'x' }])],
    })
    expect(outcome.mergeRequest).toBeUndefined()
    expect(commits).toEqual([])
  })
})
