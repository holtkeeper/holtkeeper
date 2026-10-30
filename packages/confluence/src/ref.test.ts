import { describe, expect, test } from 'bun:test'

import { ConfluenceInputError } from './errors.ts'
import { parsePageRef } from './ref.ts'

const cloud = 'https://acme.atlassian.net'

describe('parsePageRef', () => {
  test('ids and links', () => {
    expect(parsePageRef(' 12345 ', cloud)).toBe('12345')
    expect(
      parsePageRef('https://acme.atlassian.net/wiki/spaces/ENG/pages/98765/Release+Notes', cloud),
    ).toBe('98765')
    expect(
      parsePageRef('https://acme.atlassian.net/wiki/spaces/ENG/pages/edit-v2/555', cloud),
    ).toBe('555')
    expect(
      parsePageRef(
        'https://wiki.example.com/confluence/pages/viewpage.action?pageId=42',
        'https://wiki.example.com/confluence',
      ),
    ).toBe('42')
  })

  test('rejects foreign hosts and links without ids', () => {
    expect(() => parsePageRef('https://evil.example.com/wiki/spaces/X/pages/1', cloud)).toThrow(
      ConfluenceInputError,
    )
    expect(() => parsePageRef('https://acme.atlassian.net/wiki/x/AbCd', cloud)).toThrow(
      ConfluenceInputError,
    )
    expect(() => parsePageRef('page title', cloud)).toThrow(ConfluenceInputError)
  })

  test('the API gateway accepts site links', () => {
    expect(
      parsePageRef(
        'https://acme.atlassian.net/wiki/spaces/X/pages/7/T',
        'https://api.atlassian.com/ex/confluence/abc',
      ),
    ).toBe('7')
  })
})
