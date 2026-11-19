import { describe, expect, test } from 'bun:test'

import { parseConfig } from '@holtkeeper/core'

import { repoArgResolver } from './repo-arg.ts'

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
