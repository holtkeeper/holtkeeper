import { expect, test } from 'bun:test'

import { toDistPath } from './files.ts'

test('root-relative URLs resolve with a deploy base or against the page folder', () => {
  const files = new Set(['assets/x.js', 'frontend/scripts/game.js'])
  expect(toDistPath('/app/assets/x.js', '', files)).toBe('assets/x.js')
  expect(toDistPath('/scripts/game.js?v=1', 'frontend', files)).toBe('frontend/scripts/game.js')
  expect(toDistPath('/scripts/missing.js', 'frontend', files)).toBeUndefined()
  expect(toDistPath('https://cdn.example/x.js', '', files)).toBeUndefined()
})
