import { describe, expect, test } from 'bun:test'

import { validateEntry } from './schema.ts'

const draft = {
  title: 'Prefer Vitest',
  body: 'Use Vitest.',
  kind: 'convention',
  scope: { teams: ['games'] },
  topics: ['Testing', 'testing', 'CI'],
  appliesTo: ['tests'],
}

const parsed = (match: unknown) => {
  const result = validateEntry({ ...draft, match })
  if (!result.success) throw new Error(result.issues.join('; '))
  return result.data
}

describe('validateEntry', () => {
  test('accepts a draft and normalizes topics and defaults', () => {
    const result = validateEntry(draft)
    expect(result).toEqual({
      success: true,
      data: { ...draft, kind: 'convention', topics: ['testing', 'ci'], evidence: [] },
    })
  })

  test('requires packages for migrations', () => {
    expect(validateEntry({ ...draft, kind: 'migration' })).toEqual({
      success: false,
      issues: ['packages: a migration must name its packages'],
    })
    expect(validateEntry({ ...draft, kind: 'migration', packages: [] }).success).toBeFalse()
    expect(
      validateEntry({
        ...draft,
        kind: 'migration',
        packages: [{ ecosystem: 'npm', name: 'react', from: '>=18 <19' }],
      }).success,
    ).toBeTrue()
  })

  test('rejects empty scopes, empty appliesTo and bad links', () => {
    expect(validateEntry({ ...draft, scope: {} })).toEqual({
      success: false,
      issues: ['scope: scope must not be empty'],
    })
    expect(validateEntry({ ...draft, scope: { all: false, teams: [], repos: [] } }).success).toBe(
      false,
    )
    expect(validateEntry({ ...draft, appliesTo: [] })).toEqual({
      success: false,
      issues: ['appliesTo: must name at least one task kind or *'],
    })
    expect(
      validateEntry({ ...draft, evidence: [{ label: 'MR', url: 'not a url' }] }).success,
    ).toBeFalse()
    expect(validateEntry({ ...draft, title: '   ' }).success).toBeFalse()
    expect(validateEntry({ ...draft, kind: 'rumor' }).success).toBeFalse()
  })

  test('normalises match: unique lists, empty lists and empty matches dropped', () => {
    expect(parsed({ families: ['f-web', 'f-web'], files: [] }).match).toEqual({
      families: ['f-web'],
    })
    expect(parsed({ files: ['src/**/*.ts'] }).match).toEqual({ files: ['src/**/*.ts'] })
    expect('match' in parsed({ families: [], files: [] })).toBeFalse()
    expect('match' in parsed(undefined)).toBeFalse()
  })

  test('rejects blank families and files outside the repository', () => {
    expect(validateEntry({ ...draft, match: { families: [' '] } }).success).toBeFalse()
    expect(validateEntry({ ...draft, match: { files: ['/etc/*'] } })).toEqual({
      success: false,
      issues: ['match.files.0: must be a repository-relative path glob'],
    })
    expect(validateEntry({ ...draft, match: { files: ['../x/**'] } }).success).toBeFalse()
  })
})
