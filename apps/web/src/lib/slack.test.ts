import { expect, test } from 'bun:test'

import type { RepoSummary } from '@holtkeeper/api'

import { cleanBinding, newBinding, reposInScope, scopeSummary, withBinding } from './slack.ts'

const repos: RepoSummary[] = [
  { repo: { forge: 'work', path: 'g/app' }, groups: ['games'] },
  { repo: { forge: 'work', path: 't/cli' }, groups: ['tools'] },
]

test('scopes in words and the repositories they cover', () => {
  expect(scopeSummary({ all: true })).toBe('All repositories')
  expect(scopeSummary({ groups: ['games', ['web', 'shop']] })).toBe('games, web & shop')
  expect(scopeSummary({})).toBe('No repositories')
  expect(reposInScope(repos, { groups: ['games'] }).map((r) => r.repo.path)).toEqual(['g/app'])
  expect(reposInScope(repos, { all: true })).toHaveLength(2)
})

test('bindings drop default repositories outside their scope', () => {
  const binding = { ...newBinding('C1', 'releases'), defaultRepo: 'work:t/cli' }
  expect(cleanBinding(binding, repos).defaultRepo).toBe('work:t/cli')
  expect(
    cleanBinding({ ...binding, scope: { groups: ['games'] } }, repos).defaultRepo,
  ).toBeUndefined()
})

test('bindings are replaced by channel and kept in name order', () => {
  const list = withBinding([newBinding('C1', 'zeta')], newBinding('C2', 'alpha'))
  expect(list.map((b) => b.name)).toEqual(['alpha', 'zeta'])
  expect(withBinding(list, { ...newBinding('C1', 'zeta'), actions: [] })[1]?.actions).toEqual([])
})
