import { describe, expect, test } from 'bun:test'

import { commitlintOfPackageJson, parseCommitlint } from './commitlint.ts'

describe('parseCommitlint', () => {
  test('reads the conventional preset and literal rules of a JS config', () => {
    const rules = parseCommitlint(`export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [2, 'always', ['feat', 'fix', 'chore']],
    'scope-enum': [2, 'always', ['web', 'server']],
    'scope-empty': [2, 'never'],
    'header-max-length': [2, 'always', 72],
    'body-empty': [1, 'always'],
  },
}`)
    expect(rules).toEqual({
      conventional: true,
      types: ['feat', 'fix', 'chore'],
      scopes: ['web', 'server'],
      scopeRequired: true,
      maxLength: 72,
      noTrailingPeriod: true,
      body: 'none',
    })
  })

  test('reads YAML flow lists and ignores disabled rules', () => {
    expect(
      parseCommitlint(`rules:
  type-enum: [2, always, [feat, fix]]
  header-max-length: [0, always, 50]
  subject-full-stop: [2, always, '.']`),
    ).toEqual({ conventional: true, types: ['feat', 'fix'], noTrailingPeriod: false })
  })

  test('reads the commitlint section of package.json', () => {
    const section = commitlintOfPackageJson(
      JSON.stringify({ name: 'x', commitlint: { extends: ['@commitlint/config-conventional'] } }),
    )
    expect(section && parseCommitlint(section).conventional).toBe(true)
    expect(commitlintOfPackageJson('{"name":"x"}')).toBeUndefined()
    expect(commitlintOfPackageJson('not json')).toBeUndefined()
  })
})
