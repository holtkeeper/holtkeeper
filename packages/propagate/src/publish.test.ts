import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { fakeForge } from '../test/fakes.ts'
import {
  branchName,
  describeMergeRequest,
  mergeRequestBody,
  mergeRequestTitle,
  type GitPublisher,
  parseStatus,
  publishChanges,
  touchedBetween,
} from './publish.ts'
import type { CheckResult, PackageTarget } from './types.ts'

const targets: PackageTarget[] = [
  { name: '@acme/ui', ecosystem: 'npm', requested: 'latest', version: '2.0.0' },
]

const check = (name: string, ok: boolean, output = ''): CheckResult => ({
  name,
  command: `bun run ${name}`,
  exitCode: ok ? 0 : 2,
  ok,
  output,
  durationMs: 1500,
  attempt: 0,
})

describe('helpers', () => {
  test('parseStatus handles renames, deletions, untracked files and node_modules', () => {
    const output = [
      ' M package.json',
      '?? src/new.ts',
      'R  src/b.ts',
      'src/a.ts',
      ' D old.ts',
      'A  added.ts',
      '?? node_modules/x/index.js',
      '',
    ].join('\0')
    expect(parseStatus(output)).toEqual([
      { path: 'package.json', action: 'update' },
      { path: 'src/new.ts', action: 'create' },
      { path: 'src/a.ts', action: 'delete' },
      { path: 'src/b.ts', action: 'create' },
      { path: 'old.ts', action: 'delete' },
      { path: 'added.ts', action: 'create' },
    ])
  })

  test('branch names and titles', () => {
    expect(branchName('holtkeeper/update/', targets)).toBe('holtkeeper/update/acme-ui-2.0.0')
    expect(mergeRequestTitle(targets)).toBe('chore(deps): update @acme/ui to 2.0.0')
    expect(
      touchedBetween(
        new Map([
          ['a', '1'],
          ['b', '1'],
        ]),
        new Map([
          ['a', '1'],
          ['b', '2'],
          ['c', '1'],
        ]),
      ),
    ).toEqual(['b', 'c'])
  })

  test('generic description without a fix asks for attention', () => {
    const body = describeMergeRequest({
      sections: [{ title: 'Ported', body: 'from games/a!12' }],
      checks: [check('test', false, 'boom')],
      details: [{ summary: 'Source diff', body: '+x' }],
    })
    expect(body).toContain('## Ported\n\nfrom games/a!12')
    expect(body).toContain('| test `bun run test` | **failed** | 2 | 1.5 s |')
    expect(body).toContain('## Needs attention')
    expect(body).toContain('<details><summary>Source diff</summary>')
  })
})

const dirs: string[] = []
afterAll(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))))

async function checkout() {
  const dir = await mkdtemp(join(tmpdir(), 'propagate-publish-'))
  dirs.push(dir)
  await writeFile(join(dir, 'package.json'), '{"dependencies":{"@acme/ui":"^2.0.0"}}\n')
  await writeFile(join(dir, 'bun.lock'), 'lock v2\n')
  await writeFile(join(dir, 'src.ts'), 'fixed\n')
  return dir
}

const fakeGit = (changed = true) => {
  const log: string[] = []
  const git: GitPublisher = {
    async commit({ message, paths }) {
      log.push(`commit ${message} ${paths?.join(',')}`)
      return changed ? { sha: 'c0ffee' } : undefined
    },
    async push({ branch }) {
      log.push(`push ${branch}`)
      return { pushed: true, sha: 'c0ffee' }
    },
  }
  return { git, log }
}

describe('publishChanges', () => {
  const body = mergeRequestBody({
    bumps: [{ package: '@acme/ui', from: '^1.2.0', to: '^2.0.0', manifest: 'package.json' }],
    checks: [check('typecheck', true), check('test', false, 'expected 1\nreceived 2')],
    attempts: 2,
    agent: {
      summary: 'Migrated greet calls.',
      changes: ['src.ts: options object'],
      remainingProblems: ['one test'],
    },
    fixedFiles: ['src.ts'],
    notes: [
      {
        package: '@acme/ui',
        from: '1.2.0',
        to: '2.0.0',
        source: 'node_modules/@acme/ui',
        text: '## 2.0.0\n- breaking',
      },
    ],
  })

  test('commits file contents to a new branch and opens a draft when checks fail', async () => {
    const dir = await checkout()
    const { forge, commits, mergeRequests } = fakeForge({ 'games/a': {} })
    const result = await publishChanges({
      forge,
      repo: 'games/a',
      dir,
      files: [
        { path: 'package.json', action: 'update' },
        { path: 'bun.lock', action: 'update' },
        { path: 'src.ts', action: 'create' },
        { path: 'gone.ts', action: 'delete' },
      ],
      branch: 'holtkeeper/update/acme-ui-2.0.0',
      title: 'chore(deps): update @acme/ui to 2.0.0',
      description: body,
      labels: ['holtkeeper', 'dependencies'],
      failed: true,
    })
    expect(commits).toEqual([
      {
        repo: 'games/a',
        branch: 'holtkeeper/update/acme-ui-2.0.0',
        startBranch: 'main',
        message: 'chore(deps): update @acme/ui to 2.0.0',
        changes: [
          {
            action: 'update',
            path: 'package.json',
            content: '{"dependencies":{"@acme/ui":"^2.0.0"}}\n',
          },
          { action: 'update', path: 'bun.lock', content: 'lock v2\n' },
          { action: 'create', path: 'src.ts', content: 'fixed\n' },
          { action: 'delete', path: 'gone.ts' },
        ],
      },
    ])
    expect(result).toEqual({
      id: 1,
      url: 'https://git.test/games/a/-/merge_requests/1',
      draft: true,
    })
    const mr = mergeRequests[0]!
    expect(mr.labels).toEqual(['holtkeeper', 'dependencies', 'needs-attention'])
    expect(mr.targetBranch).toBe('main')
    expect(mr.description).toContain('| `@acme/ui` | `^1.2.0` | `^2.0.0` | `package.json` |')
    expect(mr.description).toContain('| test `bun run test` | **failed** | 2 | 1.5 s |')
    expect(mr.description).toContain('received 2')
    expect(mr.description).toContain('## Changes by the agent (2 attempts)')
    expect(mr.description).toContain('Files: `src.ts`')
    expect(mr.description).toContain('## Remaining problems\n\n- one test')
    expect(mr.description).toContain('Release notes: @acme/ui 1.2.0 → 2.0.0')
  })

  test('updates the open merge request and skips files already on the branch', async () => {
    const dir = await checkout()
    const branch = 'holtkeeper/update/acme-ui-2.0.0'
    const { forge, commits, updates } = fakeForge(
      { 'games/a': {} },
      {
        refs: { 'games/a': { [branch]: { 'bun.lock': 'lock v2\n', 'package.json': 'old' } } },
        mergeRequests: [
          {
            repo: 'games/a',
            id: 7,
            title: 'old',
            description: '',
            sourceBranch: branch,
            targetBranch: 'main',
            state: 'open',
            draft: true,
            labels: [],
            author: 'holtkeeper',
            webUrl: 'https://git.test/games/a/-/merge_requests/7',
          },
        ],
      },
    )
    const result = await publishChanges({
      forge,
      repo: 'games/a',
      dir,
      files: [
        { path: 'package.json', action: 'update' },
        { path: 'bun.lock', action: 'update' },
        { path: 'src.ts', action: 'update' },
      ],
      branch,
      title: 'chore(deps): update @acme/ui to 2.0.0',
      description: 'body',
      labels: ['holtkeeper'],
    })
    expect(commits).toHaveLength(1)
    expect(commits[0]!.startBranch).toBeUndefined()
    expect(commits[0]!.changes.map((change) => [change.action, change.path])).toEqual([
      ['update', 'package.json'],
      ['create', 'src.ts'],
    ])
    expect(updates).toEqual([
      {
        repo: 'games/a',
        id: 7,
        input: {
          title: 'chore(deps): update @acme/ui to 2.0.0',
          description: 'body',
          labels: ['holtkeeper'],
          draft: false,
        },
      },
    ])
    expect(result).toEqual({
      id: 7,
      url: 'https://git.test/games/a/-/merge_requests/7',
      draft: false,
    })
  })

  test('does nothing without changes and without a merge request', async () => {
    const dir = await checkout()
    const { forge, commits } = fakeForge({ 'games/a': {} })
    expect(
      await publishChanges({
        forge,
        repo: 'games/a',
        dir,
        files: [],
        branch: 'b',
        title: 't',
        description: '',
        labels: [],
      }),
    ).toBeUndefined()
    expect(commits).toEqual([])
  })

  describe('mode git', () => {
    const base = {
      repo: 'games/a',
      dir: '/unused',
      branch: 'holtkeeper/update/x',
      title: 'chore(deps): update x',
      description: 'body',
      labels: ['holtkeeper'],
      mode: 'git' as const,
    }

    test('commits and pushes in the checkout, then opens the merge request', async () => {
      const { forge, commits, mergeRequests } = fakeForge({ 'games/a': {} })
      const { git, log } = fakeGit()
      const result = await publishChanges({
        ...base,
        forge,
        git,
        files: [
          { path: 'package.json', action: 'update' },
          { path: 'gone.ts', action: 'delete' },
        ],
      })
      expect(log).toEqual([
        'commit chore(deps): update x package.json,gone.ts',
        'push holtkeeper/update/x',
      ])
      expect(commits).toEqual([])
      expect(result?.id).toBe(1)
      expect(mergeRequests[0]).toMatchObject({ sourceBranch: base.branch, targetBranch: 'main' })
    })

    test('does nothing when the checkout has no changes and no merge request exists', async () => {
      const { forge, mergeRequests } = fakeForge({ 'games/a': {} })
      const { git, log } = fakeGit(false)
      const files = [{ path: 'package.json', action: 'update' as const }]
      expect(await publishChanges({ ...base, forge, git, files })).toBeUndefined()
      expect(log).toEqual(['commit chore(deps): update x package.json'])
      expect(mergeRequests).toEqual([])
    })

    test('needs a git publisher', async () => {
      const { forge } = fakeForge({ 'games/a': {} })
      expect(
        publishChanges({ ...base, forge, files: [{ path: 'a', action: 'update' }] }),
      ).rejects.toThrow('needs a git publisher')
    })
  })
})
