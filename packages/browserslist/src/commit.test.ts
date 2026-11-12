import { describe, expect, test } from 'bun:test'

import type { CommitConventions, CommitRules, RuleSource } from '@holtkeeper/commit-conventions'

import { browserslistCommit, commitType } from './commit.ts'

const conventions = (
  rules: CommitRules,
  source: RuleSource = 'setting',
  branch: CommitConventions['branch'] = { rules: {}, sources: {}, patterns: [], examples: [] },
): CommitConventions => ({
  repo: 'acme/widgets',
  commit: {
    rules,
    sources: Object.fromEntries(Object.keys(rules).map((key) => [key, source])),
    patterns: [],
    examples: [],
  },
  branch,
  consulted: [],
})

const commit = (rules: CommitRules, configured?: string) =>
  browserslistCommit({
    version: '1.0.30001700',
    branch: 'holtkeeper/browserslist',
    conventions: conventions(rules),
    configured,
  })

describe('browserslistCommit', () => {
  test('without conventions takes the default Conventional Commits title', () => {
    expect(
      browserslistCommit({ version: '1.0.30001700', branch: 'holtkeeper/browserslist' }),
    ).toEqual({ message: 'chore(deps): update browserslist database to caniuse-lite 1.0.30001700' })
  })

  test('picks build, then chore, then the first allowed type', () => {
    expect(commitType({})).toBe('chore')
    expect(commitType({ types: ['feat', 'build', 'chore'] })).toBe('build')
    expect(commitType({ types: ['feat', 'chore'] })).toBe('chore')
    expect(commitType({ types: ['feat', 'fix'] })).toBe('feat')
    expect(commit({ conventional: true, types: ['feat', 'build'] })).toEqual({
      message: 'build(deps): update browserslist database to caniuse-lite 1.0.30001700',
    })
  })

  test('follows scopes, subject case, length and the template', () => {
    expect(commit({ conventional: true, scopes: ['web'] })).toEqual({
      message: 'chore: update browserslist database to caniuse-lite 1.0.30001700',
    })
    expect(commit({ conventional: true, maxLength: 50 })).toEqual({
      message: 'chore(deps): update caniuse-lite to 1.0.30001700',
    })
    expect(commit({ subjectCase: 'upper', template: '<type>: <subject>' })).toEqual({
      message: 'chore: Update browserslist database to caniuse-lite 1.0.30001700',
    })
    expect(
      commit({
        template: '[<TICKET>] <type>(<scope>): <subject>',
        ticket: { pattern: 'ABC-\\d+', required: false, placement: 'lead' },
      }),
    ).toEqual({ message: 'chore(deps): update browserslist database to caniuse-lite 1.0.30001700' })
    expect(
      commit({
        conventional: true,
        template: '<type>(<TICKET>): <subject>',
        ticket: { pattern: 'ABC-\\d+', required: false, placement: 'scope' },
      }),
    ).toEqual({ message: 'chore: update browserslist database to caniuse-lite 1.0.30001700' })
  })

  test('skips with a reason when a ticket key is required and none is configured', () => {
    const rules: CommitRules = {
      conventional: true,
      ticket: { pattern: 'ABC-\\d+', required: true, placement: 'bracket' },
    }
    const skipped = commit(rules)
    expect('skipped' in skipped && skipped.skipped).toContain('ticket key matching `ABC-\\d+`')
    expect(commit(rules, 'chore(deps): [ABC-12] caniuse-lite {version}')).toEqual({
      message: 'chore(deps): [ABC-12] caniuse-lite 1.0.30001700',
    })
  })

  test('falls back from a configured message the conventions reject', () => {
    expect(commit({ conventional: true, types: ['build'] }, 'Bump caniuse-lite')).toEqual({
      message: 'build(deps): update browserslist database to caniuse-lite 1.0.30001700',
    })
  })

  test('skips when the forge push rules reject the branch', () => {
    const result = browserslistCommit({
      version: '1.0.30001700',
      branch: 'holtkeeper/browserslist',
      conventions: conventions({}, 'setting', {
        rules: { prefixes: ['feature'] },
        sources: { prefixes: 'push-rules' },
        patterns: [],
        examples: [],
      }),
    })
    expect('skipped' in result && result.skipped).toContain('push rules reject branch')
  })
})
