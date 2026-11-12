import { describe, expect, test } from 'bun:test'

import { shouldAutoLoad } from './load-more.ts'

describe('shouldAutoLoad', () => {
  test('loads when the button comes into view', () => {
    expect(shouldAutoLoad(false, true, false)).toBe(true)
  })

  test('does not keep loading while the button stays in view', () => {
    expect(shouldAutoLoad(true, true, false)).toBe(false)
  })

  test('waits while a page is loading or the button is out of view', () => {
    expect(shouldAutoLoad(false, true, true)).toBe(false)
    expect(shouldAutoLoad(true, false, false)).toBe(false)
    expect(shouldAutoLoad(false, false, false)).toBe(false)
  })
})
