import { describe, expect, test } from 'bun:test'

import { parseConfig } from '@holtkeeper/core'
import type { GitForge, Repository } from '@holtkeeper/forge'

import {
  fleetRepositories,
  matchesRepoGlob,
  selectionCovers,
  staticPrefix,
  teamForges,
} from './repos.ts'

const repository = (path: string, archived = false): Repository => ({
  path,
  name: path.split('/').at(-1) ?? path,
  defaultBranch: 'main',
  webUrl: `https://forge.test/${path}`,
  cloneUrl: `https://forge.test/${path}.git`,
  archived,
})

const all = [
  repository('games/a'),
  repository('games/legacy-b'),
  repository('games/old', true),
  repository('games/deep/c'),
  repository('tools/x'),
]

const listed: string[] = []
const forgeOf = (repositories: Repository[]) =>
  ({
    kind: 'fake',
    async *listRepositories(namespace: string) {
      listed.push(namespace)
      yield* repositories.filter((r) => namespace === '' || r.path.startsWith(`${namespace}/`))
    },
    async getRepository(path: string) {
      const found = repositories.find((r) => r.path === path)
      if (!found) throw Object.assign(new Error(`404 ${path}`), { status: 404 })
      return found
    },
  }) as unknown as GitForge

const fake = (repositories: Repository[]) => ({
  kind: 'fake',
  url: 'https://forge.test',
  create: () => forgeOf(repositories),
})

const config = parseConfig({
  forges: { work: fake(all), lab: fake([repository('games/a'), repository('labs/z')]) },
  fleet: { work: { include: ['tools/*'], exclude: ['tools/x'] } },
  teams: {
    games: { owns: ['work:games/*'], exclude: ['work:games/legacy-*'] },
    deep: { owns: ['work:games/deep/c', 'work:games/old'] },
    shared: { owns: ['games/a'], consumes: ['labs/*'] },
  },
})

describe('repos', () => {
  test('staticPrefix stops at the first wildcard segment', () => {
    expect(staticPrefix('games/*')).toBe('games')
    expect(staticPrefix('games/app/**')).toBe('games/app')
    expect(staticPrefix('games/a')).toBe('games/a')
    expect(staticPrefix('*')).toBe('')
  })

  test('fleetRepositories lists what forges include and teams own or consume', async () => {
    listed.length = 0
    const resolve = fleetRepositories(config)
    expect((await resolve()).map((r) => `${r.forge}:${r.path}`)).toEqual([
      'lab:games/a',
      'lab:labs/z',
      'work:games/a',
      'work:games/deep/c',
      'work:games/legacy-b',
    ])
    expect(listed.toSorted()).toEqual(['games', 'labs', 'labs', 'tools'])
  })

  test('fleetRepositories keeps what a selection covers and lists only what it can reach', async () => {
    listed.length = 0
    const resolve = fleetRepositories(config)
    expect((await resolve({ teams: ['games'] })).map((r) => `${r.forge}:${r.path}`)).toEqual([
      'work:games/a',
    ])
    expect(listed).toEqual(['games'])
    listed.length = 0
    expect((await resolve({ teams: ['deep'] })).map((r) => r.path)).toEqual(['games/deep/c'])
    expect(listed).toEqual([])
    expect(
      (await resolve({ repos: ['lab:**', 'work:tools/*'] })).map((r) => `${r.forge}:${r.path}`),
    ).toEqual(['lab:games/a', 'lab:labs/z'])
  })

  test('selectionCovers matches owner teams or patterns, everything without either', () => {
    const repo = { forge: 'work', path: 'games/a' }
    expect(selectionCovers(config, undefined, repo)).toBeTrue()
    expect(selectionCovers(config, { teams: [], repos: [] }, repo)).toBeTrue()
    expect(selectionCovers(config, { teams: ['shared'] }, repo)).toBeTrue()
    expect(selectionCovers(config, { teams: ['deep'] }, repo)).toBeFalse()
    expect(selectionCovers(config, { teams: ['deep'], repos: ['games/*'] }, repo)).toBeTrue()
    expect(selectionCovers(config, { repos: ['lab:games/*'] }, repo)).toBeFalse()
    expect(
      selectionCovers(config, { teams: ['shared'] }, { forge: 'lab', path: 'labs/z' }),
    ).toBeFalse()
  })

  test('teamForges names the forges of qualified patterns, every forge for bare ones', () => {
    expect(teamForges(config, 'games')).toEqual(['work'])
    expect(teamForges(config, 'shared')).toEqual(['work', 'lab'])
    expect(teamForges(config, 'nope')).toEqual([])
  })

  test('matchesRepoGlob checks forge and path', () => {
    expect(matchesRepoGlob('work:games/*', { forge: 'work', path: 'games/a' })).toBeTrue()
    expect(matchesRepoGlob('work:games/*', { forge: 'other', path: 'games/a' })).toBeFalse()
    expect(matchesRepoGlob('games/*', { forge: 'other', path: 'games/a' })).toBeTrue()
    expect(matchesRepoGlob('work:games/*', { forge: 'work', path: 'games/a/b' })).toBeFalse()
  })
})
