import { describe, expect, test } from 'bun:test'

import { formatMarkupLine } from './markup.ts'

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="280" height="56"><rect width="31" height="31" rx="15.5"/><defs><linearGradient id="a" x1="20"><stop stop-opacity="0"/><stop offset="1"></stop></linearGradient></defs><text x="1">a &gt; b</text></svg>'

describe('formatMarkupLine', () => {
  test('indents a minified SVG by nesting depth', () => {
    expect(formatMarkupLine('icons/a.svg', svg)).toEqual([
      '<svg xmlns="http://www.w3.org/2000/svg" width="280" height="56">',
      '  <rect width="31" height="31" rx="15.5"/>',
      '  <defs>',
      '    <linearGradient id="a" x1="20">',
      '      <stop stop-opacity="0"/>',
      '      <stop offset="1"></stop>',
      '    </linearGradient>',
      '  </defs>',
      '  <text x="1">a &gt; b</text>',
      '</svg>',
    ])
  })

  test('keeps > inside quoted attribute values', () => {
    const line = `<svg data-x="a>b">${'<g/>'.repeat(40)}</svg>`
    expect(formatMarkupLine('a.svg', line)?.[0]).toBe('<svg data-x="a>b">')
  })

  test('leaves short lines and other files alone', () => {
    expect(formatMarkupLine('a.svg', '<svg><g/></svg>')).toBeUndefined()
    expect(formatMarkupLine('a.tsx', svg)).toBeUndefined()
    expect(formatMarkupLine('a.svg', `d="${'M0 0'.repeat(50)}"`)).toBeUndefined()
  })
})
