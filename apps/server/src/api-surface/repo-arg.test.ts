import { describe, expect, test } from 'bun:test'

import { parseConfig } from '@holtkeeper/core'

import { knownRepoChecker, repoArgResolver } from './repo-arg.ts'

const forge = (url: string) => ({ kind: 'gitlab', url, create: () => ({}) as never })

const one = parseConfig({ forges: { work: forge('https://forge.test') } })

const two = parseConfig({
  forges: { work: forge('https://forge.test'), open: forge('https://code.example') },
  teams: { shapes: { owns: ['work:shapes/*'] }, kits: { owns: ['open:kits/*'] } },
})

describe('repoArgResolver', () => {
  test('keeps forge:path and gives a bare path the only forge', () => {
    const resolve = repoArgResolver(() => one)
    expect(resolve('work:shapes/widget')).toBe('work:shapes/widget')
    expect(resolve('shapes/widget')).toBe('work:shapes/widget')
    expect(resolve(' /shapes/widget.git ')).toBe('work:shapes/widget')
  })

  test('reads git remotes and web URLs by the forge host', () => {
    const resolve = repoArgResolver(() => two)
    expect(resolve('git@forge.test:shapes/widget.git')).toBe('work:shapes/widget')
    expect(resolve('https://code.example/kits/some-lib')).toBe('open:kits/some-lib')
    expect(resolve('ssh://git@forge.test:2222/shapes/widget.git')).toBe('work:shapes/widget')
    expect(resolve('git://forge.test/shapes/widget.git')).toBe('work:shapes/widget')
    expect(resolve('git+ssh://git@forge.test/shapes/widget.git')).toBe('work:shapes/widget')
    expect(resolve('https://elsewhere.test/shapes/widget')).toBe(
      'https://elsewhere.test/shapes/widget',
    )
  })

  test('with several forges picks the one whose fleet covers the path, else leaves it', () => {
    const resolve = repoArgResolver(() => two)
    expect(resolve('shapes/widget')).toBe('work:shapes/widget')
    expect(resolve('kits/some-lib')).toBe('open:kits/some-lib')
    expect(resolve('unknown/thing')).toBe('unknown/thing')
  })

  test('a web URL has to match the forge port and path prefix, which is stripped', () => {
    const config = parseConfig({
      forges: {
        work: forge('https://forge.test'),
        same: forge('https://forge.test:9000'),
        open: forge('https://code.example:8443/gitlab/'),
      },
    })
    const resolve = repoArgResolver(() => config)
    expect(resolve('https://code.example:8443/gitlab/kits/some-lib.git')).toBe('open:kits/some-lib')
    expect(resolve('https://forge.test:9000/shapes/widget')).toBe('same:shapes/widget')
    expect(resolve('https://forge.test/shapes/widget')).toBe('work:shapes/widget')
    expect(resolve('https://code.example:8443/other/kits/some-lib')).toBe(
      'https://code.example:8443/other/kits/some-lib',
    )
    expect(resolve('git@forge.test:shapes/widget.git')).toBe('git@forge.test:shapes/widget.git')
  })
})

describe('repoArgResolver forms', () => {
  test('a forge prefix in another case, web suffixes and an address without its scheme', () => {
    const resolve = repoArgResolver(() => one)
    expect(resolve('WORK:shapes/widget')).toBe('work:shapes/widget')
    expect(resolve('https://forge.test/shapes/widget/-/merge_requests/1')).toBe(
      'work:shapes/widget',
    )
    expect(resolve('https://forge.test/shapes/widget/-/tree/main')).toBe('work:shapes/widget')
    expect(resolve('forge.test/shapes/widget')).toBe('work:shapes/widget')
    expect(resolve('shapes/widget/-/blob/main/a.ts')).toBe('work:shapes/widget')
  })
})

describe('knownRepoChecker', () => {
  test('knows analyzed repositories and those the forge finds, and remembers for a while', async () => {
    let asked = 0
    let clock = 0
    const exists = knownRepoChecker({
      analyses: {
        latestHeads: async (query) =>
          query?.repo?.path === 'shapes/widget' ? ([{ id: 'a' }] as never) : [],
      },
      configured: (id) => id === 'work',
      forgeOf: (id) =>
        id === 'work'
          ? ({
              getRepository: async (path: string) => {
                asked++
                if (path === 'shapes/down')
                  throw Object.assign(new Error('bad gateway'), { status: 502 })
                if (path.toLowerCase() !== 'shapes/new')
                  throw Object.assign(new Error('Not Found'), { status: 404 })
                return { path: 'shapes/new' }
              },
            } as never)
          : undefined,
      now: () => new Date(clock),
    })
    expect(await exists('work:shapes/widget')).toBe('work:shapes/widget')
    expect(await exists('work:Shapes/New')).toBe('work:shapes/new')
    expect(await exists('work:shapes/typo')).toBeUndefined()
    expect(await exists('work:shapes/typo')).toBeUndefined()
    expect(asked).toBe(2)
    clock = 61_000
    expect(await exists('work:shapes/typo')).toBeUndefined()
    expect(asked).toBe(3)
    expect(await exists('work:shapes/down')).toBe('work:shapes/down')
    expect(await exists('other:shapes/widget')).toBeUndefined()
    expect(await exists('shapes/widget')).toBe('shapes/widget')
  })

  test('an analyzed repository never reaches the forge, and a forge that cannot be built is no proof', async () => {
    const exists = knownRepoChecker({
      analyses: {
        latestHeads: async (query) =>
          query?.repo?.path === 'shapes/widget' ? ([{ id: 'a' }] as never) : [],
      },
      configured: () => true,
      forgeOf: () => {
        throw new Error('forge work is unavailable')
      },
      now: () => new Date(0),
    })
    expect(await exists('work:shapes/widget')).toBe('work:shapes/widget')
    expect(await exists('work:shapes/other')).toBe('work:shapes/other')
  })
})
