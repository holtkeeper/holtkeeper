import { describe, expect, test } from 'bun:test'

import { validateEntry } from './schema.ts'

const draft = {
  title: 'Prefer Vitest',
  body: 'Use Vitest.',
  kind: 'convention',
  scope: { groups: ['games'] },
  topics: ['Testing', 'testing', 'CI'],
  appliesTo: ['tests'],
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
    expect(validateEntry({ ...draft, scope: { all: false, groups: [], repos: [] } }).success).toBe(
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
})
