import { describe, expect, test } from 'bun:test'

import { router } from './router.tsx'

const concrete = (path: string) =>
  path.replace(/\/\$$/, '/gitlab/acme/widget-kit').replace(/\$[A-Za-z_]+/g, 'x')

const matched = (path: string) => router.matchRoutes(path, {}).at(-1)?.fullPath

describe('router', () => {
  test('every page path opens its own route, never a sibling splat', () => {
    const paths = Object.values(router.routesByPath)
      .filter((route) => route.fullPath !== '/' && !route.children)
      .map((route) => route.fullPath)
    expect(paths.length).toBeGreaterThan(20)
    for (const path of paths) expect([path, concrete(path)].map(matched)).toEqual([path, path])
  })

  test('the repositories list, groups and hub resolve apart', () => {
    expect(matched('/repos')).toBe('/repos/')
    expect(matched('/repos/groups')).toBe('/repos/groups')
    expect(matched('/repos/groups/g1')).toBe('/repos/groups/$groupId')
    expect(matched('/repos/gitlab/acme/widget-kit')).toBe('/repos/$')
  })
})
