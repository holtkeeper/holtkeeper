import { describe, expect, test } from 'bun:test'

import { type CaseStyle, classifyCase, fitsCase, isAmbiguousCase, toCase } from './case.ts'

describe('classifyCase', () => {
  const table: [string, CaseStyle | undefined][] = [
    ['maxSize', 'camelCase'],
    ['parseURL', 'camelCase'],
    ['user2Id', 'camelCase'],
    ['MaxSize', 'PascalCase'],
    ['HTTPServer', 'PascalCase'],
    ['MAX_SIZE', 'SCREAMING_SNAKE_CASE'],
    ['MAX_2', 'SCREAMING_SNAKE_CASE'],
    ['max_size', 'snake_case'],
    ['max-size', 'kebab-case'],
    ['count', 'flatcase'],
    ['v1', 'flatcase'],
    ['MAX', 'UPPERCASE'],
    ['_private', 'flatcase'],
    ['_maxSize', 'camelCase'],
    ['$el', 'flatcase'],
    ['__init__', 'flatcase'],
    ['class_', 'flatcase'],
    ['Max_size', 'mixed'],
    ['max_Size', 'mixed'],
    ['fooBar_baz', 'mixed'],
    ['_', undefined],
    ['$', undefined],
  ]
  for (const [name, style] of table)
    test(`${name} → ${style}`, () => expect(classifyCase(name)).toBe(style))
})

describe('compatibility', () => {
  test('a single lowercase word fits camelCase and snake_case without voting', () => {
    expect(fitsCase('count', 'camelCase')).toBe(true)
    expect(fitsCase('count', 'snake_case')).toBe(true)
    expect(fitsCase('count', 'PascalCase')).toBe(false)
    expect(isAmbiguousCase('count')).toBe(true)
    expect(isAmbiguousCase('maxSize')).toBe(false)
  })

  test('a single uppercase word fits SCREAMING_SNAKE_CASE; one letter also fits PascalCase', () => {
    expect(fitsCase('MAX', 'SCREAMING_SNAKE_CASE')).toBe(true)
    expect(fitsCase('MAX', 'PascalCase')).toBe(false)
    expect(fitsCase('T', 'PascalCase')).toBe(true)
  })
})

describe('toCase', () => {
  const table: [string, CaseStyle, string][] = [
    ['maxSize', 'SCREAMING_SNAKE_CASE', 'MAX_SIZE'],
    ['MAX_SIZE', 'camelCase', 'maxSize'],
    ['parseHTTPUrl', 'snake_case', 'parse_http_url'],
    ['max_size', 'PascalCase', 'MaxSize'],
    ['MyComponent', 'kebab-case', 'my-component'],
    ['_retryCount', 'SCREAMING_SNAKE_CASE', '_RETRY_COUNT'],
    ['user2Id', 'snake_case', 'user2_id'],
    ['max_size', 'flatcase', 'maxsize'],
    ['Foo_bar', 'mixed', 'Foo_bar'],
  ]
  for (const [name, style, expected] of table) {
    test(`${name} as ${style} → ${expected}`, () => expect(toCase(name, style)).toBe(expected))
  }
})
