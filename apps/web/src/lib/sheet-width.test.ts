import { describe, expect, test } from 'bun:test'

import { sheetIsWide } from './sheet-width.ts'

describe('sheetIsWide', () => {
  test('follows the size the page asked for until the viewer chooses', () => {
    expect(sheetIsWide('default', {})).toBe(false)
    expect(sheetIsWide('wide', {})).toBe(true)
  })

  test('the viewer choice for that size wins', () => {
    expect(sheetIsWide('default', { default: true })).toBe(true)
    expect(sheetIsWide('wide', { wide: false })).toBe(false)
    expect(sheetIsWide('wide', { default: true })).toBe(true)
  })
})
