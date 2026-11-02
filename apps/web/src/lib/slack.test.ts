import { expect, test } from 'bun:test'

import type { RepoSummary } from '@holtkeeper/api'

import {
  channelMatches,
  cleanBinding,
  newBinding,
  reposInScope,
  scopeSummary,
  withBinding,
} from './slack.ts'

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

test('channel search matches names and ids, bot channels first', () => {
  const channels = [
    { id: 'C1', name: 'frontend-releases', private: false, member: false },
    { id: 'G7', name: 'release-team', private: true, member: true },
    { id: 'C2', name: 'random', private: false, member: true },
  ]
  expect(channelMatches(channels, '#release').map((c) => c.name)).toEqual([
    'release-team',
    'frontend-releases',
  ])
  expect(channelMatches(channels, 'g7').map((c) => c.id)).toEqual(['G7'])
  expect(channelMatches(channels, 'front rel')).toHaveLength(1)
  expect(channelMatches(channels, '').map((c) => c.name)).toEqual([
    'random',
    'release-team',
    'frontend-releases',
  ])
})
