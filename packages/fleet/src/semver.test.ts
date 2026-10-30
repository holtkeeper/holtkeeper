import { describe, expect, test } from 'bun:test'

import { compareVersionText, lagOf, minimumOfRange, parseVersion } from './semver.ts'

describe('semver', () => {
  test('parses npm and Go versions', () => {
    expect(parseVersion('v1.9.1')).toEqual({ major: 1, minor: 9, patch: 1 })
    expect(parseVersion('18.3')).toEqual({ major: 18, minor: 3, patch: 0 })
    expect(parseVersion('v0.0.0-20240101-abcdef')?.pre).toBe('20240101-abcdef')
    expect(parseVersion('latest')).toBeUndefined()
  })

  test('orders versions with prereleases first', () => {
    const sorted = ['2.0.0', '2.0.0-rc.1', '1.10.0', '1.9.0'].toSorted(compareVersionText)
    expect(sorted).toEqual(['1.9.0', '1.10.0', '2.0.0-rc.1', '2.0.0'])
  })

  test('takes the lowest version a range admits', () => {
    expect(minimumOfRange('^18.2.0')).toBe('18.2.0')
    expect(minimumOfRange('~4.1')).toBe('4.1.0')
    expect(minimumOfRange('>=1.2.0 <3 || 0.9.1')).toBe('0.9.1')
    expect(minimumOfRange('npm:react@^17.0.2')).toBe('17.0.2')
    expect(minimumOfRange('workspace:*')).toBeUndefined()
    expect(minimumOfRange('github:org/repo')).toBeUndefined()
    expect(minimumOfRange('*')).toBeUndefined()
  })

  test('measures lag by the most significant part', () => {
    expect(lagOf('17.0.2', '19.1.0')).toBe('major')
    expect(lagOf('19.0.0', '19.1.0')).toBe('minor')
    expect(lagOf('19.1.0', '19.1.3')).toBe('patch')
    expect(lagOf('v1.2.3', 'v1.2.3')).toBe('current')
    expect(lagOf('2.0.0', '1.0.0')).toBe('ahead')
    expect(lagOf(undefined, '1.0.0')).toBe('unknown')
  })
})
