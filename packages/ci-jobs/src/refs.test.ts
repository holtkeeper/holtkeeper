import { describe, expect, test } from 'bun:test'

import { refGroupOf } from './refs.ts'

describe('refGroupOf', () => {
  test('groups refs the way teams name branches', () => {
    expect(refGroupOf('main')).toBe('default')
    expect(refGroupOf('master')).toBe('default')
    expect(refGroupOf('develop')).toBe('develop')
    expect(refGroupOf('dev')).toBe('develop')
    expect(refGroupOf('release/1.4')).toBe('release')
    expect(refGroupOf('hotfix-login')).toBe('release')
    expect(refGroupOf('feature/GTW-12-login')).toBe('feature')
    expect(refGroupOf('fix/typo')).toBe('feature')
    expect(refGroupOf('refs/merge-requests/42/head')).toBe('merge-request')
    expect(refGroupOf(undefined)).toBe('feature')
  })

  test('the known default branch wins, tags only by flag', () => {
    expect(refGroupOf('trunk', { defaultBranch: 'develop' })).toBe('feature')
    expect(refGroupOf('develop', { defaultBranch: 'develop' })).toBe('default')
    expect(refGroupOf('v1.2.0')).toBe('feature')
    expect(refGroupOf('v1.2.0', { tag: true })).toBe('tag')
  })
})
