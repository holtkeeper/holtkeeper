import { describe, expect, test } from 'bun:test'

import type { SettingEntry } from '@holtkeeper/store'

import { repoTests } from './definitions.ts'
import { resolveRepoTests, testsExpected } from './tests.ts'

const widget = { forge: 'acme', path: 'shapes/widget', groups: ['shapes'] }
const core = { forge: 'acme', path: 'shapes/widget-core', groups: ['shapes'] }

const entry = (
  id: string,
  scope: SettingEntry['scope'],
  value: unknown,
  secret = false,
): SettingEntry => ({
  id,
  key: 'repo.tests',
  scope,
  value,
  secret,
  updatedAt: '2026-11-01T00:00:00.000Z',
})

describe('repo.tests', () => {
  test('tests are expected without an entry', () => {
    expect(resolveRepoTests([], widget)).toEqual({ expected: true })
    expect(testsExpected([], widget)).toBe(true)
    expect(repoTests.default).toEqual({ expected: true })
  })

  test('a group entry turns tests off and a repository entry lifts it', () => {
    const group = entry('g', { groups: ['shapes'] }, { expected: false, reason: 'Config only' })
    const own = entry('r', { repos: ['shapes/widget-core'] }, { expected: true })
    expect(resolveRepoTests([group, own], widget)).toEqual({
      expected: false,
      reason: 'Config only',
      entry: group,
    })
    expect(resolveRepoTests([group, own], core)).toEqual({ expected: true, entry: own })
    expect(testsExpected([group, own], core)).toBe(true)
  })

  test('invalid and secret values count as the default', () => {
    expect(resolveRepoTests([entry('a', { all: true }, 'off')], widget)).toEqual({
      expected: true,
    })
    expect(
      resolveRepoTests([entry('s', { all: true }, { expected: false }, true)], widget),
    ).toEqual({ expected: true })
  })

  test('the schema rejects an empty reason and fills expected', () => {
    expect(repoTests.schema.safeParse({ expected: false, reason: '  ' }).success).toBe(false)
    expect(repoTests.schema.parse({})).toEqual({ expected: true })
  })
})
