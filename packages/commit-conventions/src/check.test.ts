import { describe, expect, test } from 'bun:test'

import { checkBranchName, checkCommitMessage } from './check.ts'
import type { BranchRules, CommitRules, Ruleset } from './types.ts'

const commits: Ruleset<CommitRules> = {
  rules: {
    conventional: true,
    types: ['feat', 'fix'],
    ticket: { pattern: 'GTW-\\d+', required: true, placement: 'bracket' },
    maxLength: 72,
    subjectCase: 'lower',
    noTrailingPeriod: true,
    body: 'none',
  },
  sources: {
    conventional: 'setting',
    types: 'commitlint',
    ticket: 'setting',
    maxLength: 'history',
    subjectCase: 'history',
    noTrailingPeriod: 'history',
    body: 'history',
  },
  patterns: [{ source: 'push-rules', pattern: '(?i)^(feat|fix)' }],
  examples: [],
}

const messages = (message: string) =>
  checkCommitMessage(commits, message).map((problem) => `${problem.severity}: ${problem.message}`)

describe('checkCommitMessage', () => {
  test('accepts a message that follows every rule', () => {
    expect(messages('feat(web): [GTW-1] add the board')).toEqual([])
    expect(messages('fix: [GTW-2] API errors keep their status')).toEqual([])
  })

  test('reports configured rules as errors and learned ones as warnings', () => {
    expect(messages('chore: Bump deps.\n\nBecause.')).toEqual([
      'error: The message must match `(?i)^(feat|fix)`',
      'error: Type `chore` is not one of feat, fix',
      'error: The title needs a ticket key matching `GTW-\\d+`',
      'warning: Start the subject with a lowercase letter',
      'warning: Drop the trailing period',
      'warning: Write the title only, without a body',
    ])
    expect(messages('Add things')).toContain(
      'error: The title must look like `type(scope): subject`',
    )
  })

  test('ignores git trailers when looking for a body', () => {
    expect(messages('fix: [GTW-3] retry\n\nCo-Authored-By: A <a@example.com>')).toEqual([])
  })
})

describe('checkBranchName', () => {
  const branches: Ruleset<BranchRules> = {
    rules: {
      prefixes: ['feat', 'fix'],
      ticket: { pattern: 'GTW-\\d+', required: true },
      case: 'kebab',
    },
    sources: { prefixes: 'history', ticket: 'setting', case: 'history' },
    patterns: [{ source: 'push-rules', pattern: '^(feat|fix)/' }],
    examples: [],
  }
  const names = (name: string) => checkBranchName(branches, name).map((p) => p.message)

  test('accepts a conforming name', () => {
    expect(names('feat/GTW-12-release-board')).toEqual([])
  })

  test('reports every broken rule', () => {
    expect(names('Release_Board')).toEqual([
      'The branch name must match `^(feat|fix)/`',
      'Start with one of `feat/`, `fix/`',
      'The name needs a ticket key matching `GTW-\\d+`',
      'Use lowercase words joined by `-`',
    ])
  })
})
