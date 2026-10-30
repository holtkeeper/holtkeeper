import { describe, expect, test } from 'bun:test'

import type { GitForge, Repository } from '@holtkeeper/forge'

import {
  intentSummary,
  issueReferences,
  parseRepo,
  parseSourceSpec,
  sourceKind,
  sourceSlug,
} from './source.ts'
import { resolveTargets } from './targets.ts'
import type { SourceChange } from './types.ts'

describe('source specs', () => {
  test('parses the command form', () => {
    expect(parseSourceSpec('work:libs/core!12')).toEqual({
      repo: 'work:libs/core',
      mergeRequest: 12,
    })
    expect(parseSourceSpec('libs/core@abc1234,def5678')).toEqual({
      repo: 'libs/core',
      commits: ['abc1234', 'def5678'],
    })
    expect(parseSourceSpec('libs/core@v1.0.0..main')).toEqual({
      repo: 'libs/core',
      range: { from: 'v1.0.0', to: 'main' },
    })
    expect(() => parseSourceSpec('libs/core')).toThrow()
  })

  test('requires exactly one kind of change', () => {
    expect(sourceKind({ repo: 'a', mergeRequest: 1 })).toBe('merge-request')
    expect(() => sourceKind({ repo: 'a', mergeRequest: 1, commits: ['abc'] })).toThrow()
    expect(() => sourceKind({ repo: 'a' })).toThrow()
  })

  test('splits forge and path', () => {
    expect(parseRepo('work:libs/core', 'x')).toEqual({ forge: 'work', path: 'libs/core' })
    expect(parseRepo('libs/core', 'x')).toEqual({ forge: 'x', path: 'libs/core' })
  })
})

describe('intent', () => {
  const change: SourceChange = {
    repo: 'work:libs/core',
    path: 'libs/core',
    kind: 'merge-request',
    mergeRequest: 12,
    title: 'Require a password',
    description: 'Fixes #3 and GTW-435, see https://git.test/libs/core/-/issues/9.',
    webUrl: 'https://git.test/libs/core/-/merge_requests/12',
    issues: [],
    files: [
      {
        oldPath: 'src/login.ts',
        newPath: 'src/login.ts',
        status: 'modified',
        diff: '@@ -1,2 +1,3 @@ export function login() {\n a\n+b\n c\n',
      },
    ],
  }

  test('finds issue references', () => {
    expect(issueReferences(change.description)).toEqual([
      '#3',
      'GTW-435',
      'https://git.test/libs/core/-/issues/9',
    ])
    expect(issueReferences('see !12 and a#4')).toEqual([])
  })

  test('summarizes deterministically', () => {
    const text = intentSummary(change)
    expect(text).toContain('Title: Require a password')
    expect(text).toContain(
      'Source: work:libs/core!12 (https://git.test/libs/core/-/merge_requests/12)',
    )
    expect(text).toContain('- M src/login.ts (+1 −0): `export function login() {`')
    expect(intentSummary(change)).toBe(text)
  })

  test('slugs the source for branch names', () => {
    expect(sourceSlug(change)).toBe('core-mr-12')
    expect(sourceSlug({ path: 'libs/core', kind: 'commits', commits: ['abcdef1234567'] })).toBe(
      'core-abcdef12',
    )
    expect(
      sourceSlug({ path: 'libs/Core', kind: 'range', range: { from: 'v1.0.0', to: 'main' } }),
    ).toBe('core-v1.0.0-main')
  })
})

describe('resolveTargets', () => {
  const repos = ['games/a', 'games/b', 'games/nested/c', 'libs/core', 'tools/x'].map((path) => ({
    forge: 'work',
    path,
  }))
  const forge = {
    async *listRepositories(namespace: string): AsyncIterable<Repository> {
      if (namespace === 'apps')
        yield {
          path: 'apps/web',
          name: 'web',
          defaultBranch: 'main',
          webUrl: '',
          cloneUrl: '',
          archived: false,
        }
    },
  } as unknown as GitForge
  const paths = async (patterns: string[]) =>
    (
      await resolveTargets({
        patterns,
        group: 'fleet',
        repos,
        source: 'libs/core',
        forge,
        forgeId: 'work',
      })
    ).map((repo) => repo.path)

  test('defaults to every repository but the source', async () => {
    expect(await paths([])).toEqual(['games/a', 'games/b', 'games/nested/c', 'tools/x'])
    expect(await paths(['fleet'])).toEqual(['games/a', 'games/b', 'games/nested/c', 'tools/x'])
  })

  test('turns a namespace into its repositories', async () => {
    expect(await paths(['games'])).toEqual(['games/a', 'games/b'])
    expect(await paths(['games/**', 'tools/x'])).toEqual([
      'games/a',
      'games/b',
      'games/nested/c',
      'tools/x',
    ])
    expect(await paths(['apps'])).toEqual(['apps/web'])
    expect(await paths(['libs/core'])).toEqual([])
  })
})
