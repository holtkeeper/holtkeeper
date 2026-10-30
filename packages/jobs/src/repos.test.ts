import { describe, expect, test } from 'bun:test'

import { parseConfig } from '@holtkeeper/core'
import type { GitForge, Repository } from '@holtkeeper/forge'

import { groupRepositories, matchesRepoGlob, staticPrefix } from './repos.ts'

const repository = (path: string, archived = false): Repository => ({
  path,
  name: path.split('/').at(-1) ?? path,
  defaultBranch: 'main',
  webUrl: `https://forge.test/${path}`,
  cloneUrl: `https://forge.test/${path}.git`,
  archived,
})

const listed: string[] = []
const forge = {
  kind: 'fake',
  async *listRepositories(namespace: string) {
    listed.push(namespace)
    const all = [
      repository('games/a'),
      repository('games/legacy-b'),
      repository('games/old', true),
      repository('games/deep/c'),
      repository('tools/x'),
    ]
    yield* all.filter((r) => r.path.startsWith(`${namespace}/`))
  },
} as unknown as GitForge

const config = parseConfig({
  forges: { work: { kind: 'fake', url: 'https://forge.test', create: () => forge } },
  groups: {
    games: { forge: 'work', include: ['games/*'], exclude: ['games/legacy-*'] },
    everything: { forge: 'work', include: ['games/**', 'tools/*'] },
  },
})

describe('repos', () => {
  test('staticPrefix stops at the first wildcard segment', () => {
    expect(staticPrefix('games/*')).toBe('games')
    expect(staticPrefix('games/slots/**')).toBe('games/slots')
    expect(staticPrefix('games/a')).toBe('games/a')
    expect(staticPrefix('*')).toBe('')
  })

  test('groupRepositories lists include prefixes and applies the globs', async () => {
    const resolve = groupRepositories(config)
    expect((await resolve('games')).map((r) => r.path)).toEqual(['games/a'])
    expect((await resolve('everything')).map((r) => r.path)).toEqual([
      'games/a',
      'games/deep/c',
      'games/legacy-b',
      'tools/x',
    ])
    expect(listed).toContain('tools')
    expect(resolve('nope')).rejects.toThrow('unknown group')
  })

  test('matchesRepoGlob checks forge and path', () => {
    expect(matchesRepoGlob('work:games/*', { forge: 'work', path: 'games/a' })).toBeTrue()
    expect(matchesRepoGlob('work:games/*', { forge: 'other', path: 'games/a' })).toBeFalse()
    expect(matchesRepoGlob('work:games/*', { forge: 'work', path: 'games/a/b' })).toBeFalse()
  })
})
