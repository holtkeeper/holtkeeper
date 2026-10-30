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

const all = [
  repository('games/a'),
  repository('games/legacy-b'),
  repository('games/old', true),
  repository('games/deep/c'),
  repository('tools/x'),
]

const listed: string[] = []
const forge = {
  kind: 'fake',
  async *listRepositories(namespace: string) {
    listed.push(namespace)
    yield* all.filter((r) => r.path.startsWith(`${namespace}/`))
  },
  async getRepository(path: string) {
    const found = all.find((r) => r.path === path)
    if (!found) throw new Error(`404 ${path}`)
    return found
  },
} as unknown as GitForge

const config = parseConfig({
  forges: { work: { kind: 'fake', url: 'https://forge.test', create: () => forge } },
  groups: {
    games: { forge: 'work', include: ['games/*'], exclude: ['games/legacy-*'] },
    everything: { forge: 'work', include: ['games/**', 'tools/*'] },
    picked: {
      forge: 'work',
      include: ['games/deep/c', 'games/old', 'tools/*'],
      exclude: ['tools/x'],
    },
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

  test('groupRepositories reads exact paths instead of listing them as namespaces', async () => {
    listed.length = 0
    const resolve = groupRepositories(config)
    expect((await resolve('picked')).map((r) => r.path)).toEqual(['games/deep/c'])
    expect(listed).toEqual(['tools'])
  })

  test('matchesRepoGlob checks forge and path', () => {
    expect(matchesRepoGlob('work:games/*', { forge: 'work', path: 'games/a' })).toBeTrue()
    expect(matchesRepoGlob('work:games/*', { forge: 'other', path: 'games/a' })).toBeFalse()
    expect(matchesRepoGlob('work:games/*', { forge: 'work', path: 'games/a/b' })).toBeFalse()
  })
})
