import { describe, expect, test } from 'bun:test'

import type { BranchRecord, CommitRecord, PushRules } from '@holtkeeper/forge'

import { renderCommitConventions, renderProblems } from './render.ts'
import { type ConventionsForge, commitConventions } from './resolve.ts'

const record = (title: string, i: number): CommitRecord => ({
  sha: `s${i}`,
  parents: ['p'],
  authorName: 'A',
  authorEmail: 'a@example.com',
  authoredAt: `2026-10-${String(30 - i).padStart(2, '0')}T00:00:00Z`,
  title,
  message: title,
})

const branch = (name: string, day: number): BranchRecord => ({
  name,
  sha: name,
  committedAt: `2026-10-${String(day).padStart(2, '0')}T00:00:00Z`,
  merged: false,
  protected: false,
  default: false,
})

const titles = [
  'feat(web): [ABC-1] add the board',
  'fix(server): [ABC-2] retry snapshots',
  'feat(core): [ABC-3] read push rules',
  'fix(web): [ABC-4] keep scroll',
  'refactor(web): [ABC-5] split the view',
  'feat(server): [ABC-6] knowledge tools',
  'chore(deps): [ABC-7] bump zod',
  'fix(core): [ABC-8] handle null',
  'feat(cli): [ABC-9] release command',
  'Docs(core): [ABC-10] Describe the contract.',
]

function fakeForge(options: {
  files?: Record<string, string>
  pushRules?: PushRules
  listFiles?: boolean
}): ConventionsForge {
  const files = options.files ?? {}
  return {
    getRepository: async (path) => ({
      path,
      name: path,
      defaultBranch: 'main',
      webUrl: '',
      cloneUrl: '',
      archived: false,
    }),
    readFile: async (_repo, file) => files[file],
    ...(options.listFiles === false
      ? {}
      : {
          listFiles: async () =>
            Object.keys(files).map((path) => ({ path, type: 'file' as const })),
        }),
    listCommits: async (_repo, query) => titles.map(record).slice(0, query.limit),
    listBranches: async () => [
      { ...branch('main', 30), default: true, protected: true },
      branch('feat/ABC-1-board', 29),
      branch('fix/ABC-2-snapshots', 28),
      branch('feat/ABC-3-push-rules', 27),
      branch('fix/ABC-4-scroll', 26),
      branch('feat/Wrong_Name', 25),
    ],
    getPushRules: async () => options.pushRules,
  }
}

describe('commitConventions', () => {
  test('combines the setting, push rules, commitlint and history by strength', async () => {
    const conventions = await commitConventions({
      forge: fakeForge({
        files: {
          'commitlint.config.ts': `export default { extends: ['@commitlint/config-conventional'] }`,
        },
        pushRules: { commitMessage: '^(feat|fix|chore|refactor|docs)', branchName: '^(feat|fix)/' },
      }),
      repo: 'g/app',
      label: 'gitlab:g/app',
      setting: {
        history: true,
        commit: { maxLength: 60, examples: ['feat(web): [ABC-42] configured example'] },
        notes: 'Squash before merging.',
      },
    })

    expect(conventions.commit.sources).toMatchObject({
      maxLength: 'setting',
      conventional: 'commitlint',
      types: 'commitlint',
      ticket: 'history',
      subjectCase: 'history',
    })
    expect(conventions.commit.rules.template).toBe('<type>(<scope>): [<TICKET>] <subject>')
    expect(conventions.commit.patterns).toEqual([
      { source: 'push-rules', pattern: '^(feat|fix|chore|refactor|docs)' },
    ])
    expect(conventions.commit.examples[0]).toBe('feat(web): [ABC-42] configured example')
    expect(conventions.commit.examples).not.toContain(titles[9])
    expect(conventions.branch.examples).toEqual([
      'feat/ABC-1-board',
      'fix/ABC-2-snapshots',
      'feat/ABC-3-push-rules',
      'fix/ABC-4-scroll',
    ])
    expect(conventions.consulted.map((item) => item.detail)).toEqual([
      'commits.conventions setting',
      'push rules of the forge',
      'commitlint.config.ts',
      'last 10 commits on main',
      '5 branches',
    ])

    const text = renderCommitConventions(conventions)
    expect(text).toContain('# Commit conventions of gitlab:g/app')
    expect(text).toContain('Template: `<type>(<scope>): [<TICKET>] <subject>`')
    expect(text).toContain('- Title at most 60 characters _(team setting)_')
    expect(text).toContain(
      '- The whole message must match `^(feat|fix|chore|refactor|docs)` _(push rule, enforced by the forge)_',
    )
    expect(text).toContain('## Team notes\n\nSquash before merging.')
  })

  test('skips history when the setting turns it off and reads package.json without a listing', async () => {
    const conventions = await commitConventions({
      forge: fakeForge({
        listFiles: false,
        files: {
          'package.json': JSON.stringify({
            commitlint: { rules: { 'header-max-length': [2, 'always', 80] } },
          }),
        },
      }),
      repo: 'g/app',
      setting: { history: false },
    })
    expect(conventions.history).toBeUndefined()
    expect(conventions.commit.rules).toEqual({ maxLength: 80 })
    expect(conventions.commit.examples).toEqual([])
  })

  test('renders an empty result and check verdicts', async () => {
    const forge = fakeForge({})
    const conventions = await commitConventions({
      forge: { ...forge, listCommits: async () => [], listBranches: async () => [] },
      repo: 'g/app',
    })
    expect(renderCommitConventions(conventions)).toContain('No rules found')
    expect(
      renderProblems([
        { what: 'Message', problems: [] },
        {
          what: 'Branch',
          problems: [
            {
              message: 'Use lowercase words joined by `-`',
              source: 'history',
              severity: 'warning',
            },
          ],
        },
      ]),
    ).toBe(
      'Message: follows every known rule.\n\nBranch: unusual for this repository\n- warning: Use lowercase words joined by `-` _(history)_',
    )
  })
})
