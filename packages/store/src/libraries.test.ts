import { describe, expect, test } from 'bun:test'

import { compareLibraryVersions, libraryQueryTerms, newestVersionsFirst } from './libraries.ts'

describe('compareLibraryVersions', () => {
  test('orders by semantic version with prereleases below their release', () => {
    expect(
      newestVersionsFirst([
        '1.9.0',
        '1.10.0',
        '1.10.0-alpha',
        '1.10.0-alpha.1',
        '1.10.0-alpha.beta',
        '1.10.0-beta.2',
        '1.10.0-beta.11',
        '1.10.0-rc.1',
        'v2.0.0+incompatible',
        'latest',
        '1.9.0',
      ]),
    ).toEqual([
      'v2.0.0+incompatible',
      '1.10.0',
      '1.10.0-rc.1',
      '1.10.0-beta.11',
      '1.10.0-beta.2',
      '1.10.0-alpha.beta',
      '1.10.0-alpha.1',
      '1.10.0-alpha',
      '1.9.0',
      'latest',
    ])
    expect(compareLibraryVersions('v1.2.3', 'v1.2.3')).toBe(0)
    expect(compareLibraryVersions('1.2', '1.2.0')).not.toBe(0)
  })
})

describe('libraryQueryTerms', () => {
  test('splits words, keeps quoted phrases and treats an unclosed quote as text', () => {
    expect(libraryQueryTerms('Cannot read "property map" of')).toEqual([
      ['cannot'],
      ['read'],
      ['property', 'map'],
      ['of'],
    ])
    expect(libraryQueryTerms('"single" "a b" "a b" "open quote')).toEqual([
      ['single'],
      ['a', 'b'],
      ['open'],
      ['quote'],
    ])
    expect(libraryQueryTerms(' "" (*) ')).toEqual([])
  })
})
