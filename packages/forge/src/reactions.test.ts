import { expect, test } from 'bun:test'

import { reactionCounts } from './reactions.ts'

test('counts thumbs up and down under every forge name', () => {
  expect(
    reactionCounts([
      { name: 'thumbsup', user: 'ana' },
      { name: '+1', user: 'ben' },
      { name: 'thumbsdown', user: 'cy' },
      { name: 'rocket', user: 'dee' },
    ]),
  ).toEqual({ up: 2, down: 1 })
})
