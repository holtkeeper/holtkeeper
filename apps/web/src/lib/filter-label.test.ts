import { expect, test } from 'bun:test'

import { filterLabel } from './filter-label.ts'

test('reads All when nothing is chosen', () => {
  expect(filterLabel('Group', [])).toBe('Group: All')
  expect(filterLabel('Status', [], { all: 'Any' })).toBe('Status: Any')
})

test('lists up to two values, then counts the rest', () => {
  expect(filterLabel('Group', ['Web'])).toBe('Group: Web')
  expect(filterLabel('Group', ['Web', 'Payments'])).toBe('Group: Web, Payments')
  expect(filterLabel('Group', ['Web', 'Payments', 'Platform', 'Tools'])).toBe(
    'Group: Web, Payments +2',
  )
  expect(filterLabel('Forge', ['github.com', 'gitlab.acme.dev'], { shown: 1 })).toBe(
    'Forge: github.com +1',
  )
})
