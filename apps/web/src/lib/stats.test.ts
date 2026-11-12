import { expect, test } from 'bun:test'

import { defined, median } from './stats.ts'

test('median takes the middle value or the mean of the two middle ones', () => {
  expect(median([])).toBeUndefined()
  expect(median([3, 1, 2])).toBe(2)
  expect(median([4, 1, 3, 2])).toBe(2.5)
})

test('defined drops undefined values', () => {
  expect(defined([1, undefined, 0, 2])).toEqual([1, 0, 2])
})
