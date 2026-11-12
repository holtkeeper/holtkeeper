import { describe, expect, test } from 'bun:test'

import {
  byGroupTitle,
  groupMatchTitle,
  groupMatchesQuery,
  groupTitleOf,
  keyAsTitle,
  validateGroupTitle,
  withGroupTitle,
} from './group-titles.ts'

const titleOf = groupTitleOf({ shapes: 'Shape studio', colors: 'Color lab' })

describe('group titles', () => {
  test('shows the title, else the key', () => {
    expect(titleOf('shapes')).toBe('Shape studio')
    expect(titleOf('sounds')).toBe('sounds')
    expect(titleOf('toString')).toBe('toString')
    expect(groupTitleOf(undefined)('shapes')).toBe('shapes')
    expect(keyAsTitle('shapes')).toBe('shapes')
  })

  test('titles every group of an intersection', () => {
    expect(groupMatchTitle('shapes', titleOf)).toBe('Shape studio')
    expect(groupMatchTitle(['shapes', 'sounds'], titleOf)).toBe('Shape studio + sounds')
  })

  test('sorts by title and filters by title or key', () => {
    expect(['shapes', 'sounds', 'colors'].toSorted(byGroupTitle(titleOf))).toEqual([
      'colors',
      'shapes',
      'sounds',
    ])
    expect(groupMatchesQuery('shapes', titleOf, 'studio')).toBeTrue()
    expect(groupMatchesQuery('shapes', titleOf, 'SHA')).toBeTrue()
    expect(groupMatchesQuery('shapes', titleOf, 'lab')).toBeFalse()
    expect(groupMatchesQuery('shapes', titleOf, ' ')).toBeTrue()
  })

  test('edits the display name of a group document', () => {
    const data = { forge: 'work', include: ['shapes/*'], exclude: [] as string[] }
    expect(withGroupTitle(data, '  Shape studio ')).toEqual({ ...data, title: 'Shape studio' })
    expect(withGroupTitle({ ...data, title: 'Old' }, ' ')).toEqual(data)
    expect(validateGroupTitle('x'.repeat(60))).toBeUndefined()
    expect(validateGroupTitle('x'.repeat(61))).toBe('At most 60 characters')
  })
})
