import { expect, test } from 'bun:test'

import { shownText } from './list-footer.ts'

test('shows the loaded part of a list', () => {
  expect(shownText(10, 1284)).toBe('Showing 10 of 1,284')
  expect(shownText(16, 84, 'files')).toBe('Showing 16 of 84 files')
})

test('says all once everything is loaded', () => {
  expect(shownText(12, 12, 'repositories')).toBe('Showing all 12 repositories')
  expect(shownText(1, 1, 'job')).toBe('Showing 1 job')
  expect(shownText(0, 0)).toBe('Showing 0')
})
