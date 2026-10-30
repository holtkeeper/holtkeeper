import { describe, expect, test } from 'bun:test'

import { confluenceFromCredential, validateConfluenceCredentialOptions } from './credential.ts'

describe('validateConfluenceCredentialOptions', () => {
  test('ignores other kinds', () => {
    expect(validateConfluenceCredentialOptions('gitlab', {})).toBeUndefined()
  })

  test('accepts basic with email and bearer', () => {
    expect(
      validateConfluenceCredentialOptions('confluence', { authKind: 'basic', email: 'a@b.c' }),
    ).toEqual([])
    expect(
      validateConfluenceCredentialOptions('confluence', {
        authKind: 'bearer',
        flavor: 'datacenter',
      }),
    ).toEqual([])
  })

  test('reports problems by field', () => {
    expect(validateConfluenceCredentialOptions('confluence', { authKind: 'basic' })).toEqual([
      expect.stringMatching(/^options\.email:/),
    ])
    expect(validateConfluenceCredentialOptions('confluence', undefined)).toEqual([
      expect.stringMatching(/^options\.authKind:/),
    ])
  })
})

describe('confluenceFromCredential', () => {
  test('builds a source and sink', () => {
    const site = confluenceFromCredential(
      {
        kind: 'confluence',
        url: 'https://acme.atlassian.net',
        options: { authKind: 'basic', email: 'a@b.c' },
      },
      'token',
    )
    expect(site.source.provider).toBe('confluence')
    expect(site.sink.provider).toBe('confluence')
  })

  test('rejects wrong kinds and options', () => {
    expect(() => confluenceFromCredential({ kind: 'gitlab', url: 'https://x' }, 's')).toThrow(
      'expected a confluence',
    )
    expect(() =>
      confluenceFromCredential({ kind: 'confluence', url: 'https://x', options: {} }, 's'),
    ).toThrow('invalid confluence credential options')
  })
})
