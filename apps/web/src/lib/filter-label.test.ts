import { expect, test } from 'bun:test'

import { filterLabel } from './filter-label.ts'

test('reads All when nothing is chosen', () => {
  expect(filterLabel('Team', [])).toBe('Team: All')
  expect(filterLabel('Status', [], { all: 'Any' })).toBe('Status: Any')
})

test('lists up to two values, then counts the rest', () => {
  expect(filterLabel('Team', ['Web'])).toBe('Team: Web')
  expect(filterLabel('Team', ['Web', 'Payments'])).toBe('Team: Web, Payments')
  expect(filterLabel('Team', ['Web', 'Payments', 'Platform', 'Tools'])).toBe(
    'Team: Web, Payments +2',
  )
  expect(filterLabel('Forge', ['github.com', 'gitlab.acme.dev'], { shown: 1 })).toBe(
    'Forge: github.com +1',
  )
})
