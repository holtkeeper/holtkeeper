import { expect, test } from 'bun:test'

import { commitPolicyFacts, policiesFor, testIdPolicyFacts } from './policies.ts'

const repo = { forge: 'work', path: 'games/a', groups: ['games'] }

test('commit conventions become plain facts', () => {
  expect(
    commitPolicyFacts({
      commit: {
        conventional: true,
        types: ['feat', 'fix'],
        ticket: { pattern: 'ABC-\\d+', required: true, placement: 'scope' },
        maxLength: 72,
      },
      branch: { prefixes: ['feature', 'fix'] },
      notes: 'Squash before merging.',
      history: true,
    }),
  ).toBe(
    [
      '- Commit messages follow Conventional Commits.',
      '- Allowed commit types: `feat`, `fix`.',
      '- Commit messages must name a ticket matching `ABC-\\d+` (scope).',
      '- Commit titles have at most 72 characters.',
      '- Branch prefixes: `feature`, `fix`.',
      'Squash before merging.',
    ].join('\n'),
  )
  expect(commitPolicyFacts({ history: true })).toBe('')
})

const entry = (scope: object, value: unknown) => ({
  id: JSON.stringify(scope),
  key: 'commits.conventions',
  scope,
  value,
  secret: false,
  updatedAt: '2026-11-01T10:00:00.000Z',
})

test('policiesFor reads the setting that applies to the repository', () => {
  expect(
    policiesFor(
      [
        entry({ all: true }, { commit: { maxLength: 100 } }),
        entry({ groups: ['games'] }, { commit: { maxLength: 72 } }),
      ],
      repo,
    ),
  ).toEqual([{ section: 'commits', text: '- Commit titles have at most 72 characters.' }])
  expect(policiesFor([entry({ all: true }, { commit: { maxLength: 'x' } })], repo)).toEqual([])
  expect(policiesFor([], repo)).toEqual([])
})

test('test id overrides from the testids analyzer options become facts of the testids section', () => {
  const testids = (scope: object, value: unknown) => ({
    ...entry(scope, value),
    key: 'analyzers.testids',
  })
  expect(
    policiesFor(
      [
        testids({ repos: ['work:games/a'] }, { attributes: ['data-qa'], exclude: ['legacy/**'] }),
        entry({ all: true }, { commit: { maxLength: 100 } }),
      ],
      repo,
    ),
  ).toEqual([
    {
      section: 'testids',
      text: [
        '- Test ids use `data-qa`; new ids use `data-qa`.',
        '- Files that need no test ids: `legacy/**`.',
      ].join('\n'),
    },
    { section: 'commits', text: '- Commit titles have at most 100 characters.' },
  ])
  expect(policiesFor([testids({ all: true }, { sources: ['vue'] })], repo)).toEqual([])
})

const assets = (scope: object, value: unknown) => ({
  ...entry(scope, value),
  key: 'assets.policy',
})

test('an asset policy entry becomes facts of the assets section; without one nothing is added', () => {
  const [policy] = policiesFor(
    [assets({ groups: ['games'] }, { formats: { raster: 'keep' }, maxDimension: 4096 })],
    repo,
  )
  expect(policy?.section).toBe('assets')
  expect(policy?.text).toContain(
    '- Raster images keep their formats; no modern format is required.',
  )
  expect(policy?.text).toContain('- Images and videos are at most 4096 px wide or tall.')
  expect(policiesFor([assets({ groups: ['other'] }, {})], repo)).toEqual([])
})

const tests = (scope: object, value: unknown) => ({ ...entry(scope, value), key: 'repo.tests' })

test('a repository with no tests by design gets a general policy line', () => {
  expect(
    policiesFor([tests({ groups: ['games'] }, { expected: false, reason: 'Config only' })], repo),
  ).toEqual([
    {
      section: 'general',
      text: '- This repository has no tests by design (Config only): do not add test files, test frameworks or test scripts, do not run tests, and do not ask for tests in reviews.',
    },
  ])
  expect(
    policiesFor(
      [
        tests({ groups: ['games'] }, { expected: false }),
        tests({ repos: ['work:games/a'] }, { expected: true }),
      ],
      repo,
    ),
  ).toEqual([])
})

test('several team test id attributes leave the choice to what the repository uses', () => {
  expect(testIdPolicyFacts({ attributes: ['data-e2e', 'data-qa'] })).toBe(
    '- Test ids use `data-e2e`, `data-qa`; new ids use the one the repository already uses most (`data-e2e` when it uses none).',
  )
})
