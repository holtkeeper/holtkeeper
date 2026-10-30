import { describe, expect, test } from 'bun:test'

import { refGroupOf } from './refs.ts'

describe('refGroupOf', () => {
  test('groups refs the way teams name branches', () => {
    expect(refGroupOf('main')).toBe('main')
    expect(refGroupOf('master')).toBe('main')
    expect(refGroupOf('production')).toBe('main')
    expect(refGroupOf('develop')).toBe('develop')
    expect(refGroupOf('development')).toBe('develop')
    expect(refGroupOf('release/1.4')).toBe('release')
    expect(refGroupOf('hotfix-login')).toBe('release')
    expect(refGroupOf('feature/GTW-12-login')).toBe('feature')
    expect(refGroupOf('fix/typo')).toBe('feature')
    expect(refGroupOf('refs/merge-requests/42/head')).toBe('merge-request')
    expect(refGroupOf(undefined)).toBe('feature')
  })

  test('main stays main when the default branch is development', () => {
    const options = { defaultBranch: 'development' }
    expect(refGroupOf('main', options)).toBe('main')
    expect(refGroupOf('development', options)).toBe('develop')
  })

  test('an unusual default branch joins the main branches; tags only by flag', () => {
    expect(refGroupOf('stable', { defaultBranch: 'stable' })).toBe('main')
    expect(refGroupOf('stable')).toBe('feature')
    expect(refGroupOf('v1.2.0')).toBe('feature')
    expect(refGroupOf('v1.2.0', { tag: true })).toBe('tag')
  })
})
