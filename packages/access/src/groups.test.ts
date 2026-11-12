import { describe, expect, test } from 'bun:test'

import {
  GROUP_KEY_PATTERN,
  groupLineage,
  isSubgroup,
  leafGroups,
  outerGroups,
  parentGroup,
  rootGroup,
} from './groups.ts'

describe('group keys', () => {
  test('accept a root group and one level of subgroups', () => {
    expect(GROUP_KEY_PATTERN.test('shapes')).toBe(true)
    expect(GROUP_KEY_PATTERN.test('shapes.round')).toBe(true)
    expect(GROUP_KEY_PATTERN.test('shapes.round.small')).toBe(false)
    expect(GROUP_KEY_PATTERN.test('Shapes')).toBe(false)
    expect(GROUP_KEY_PATTERN.test('shapes.')).toBe(false)
    expect(GROUP_KEY_PATTERN.test('.round')).toBe(false)
  })

  test('derive the parent and root from the key', () => {
    expect(parentGroup('shapes')).toBeUndefined()
    expect(parentGroup('shapes.round')).toBe('shapes')
    expect(rootGroup('shapes.round')).toBe('shapes')
    expect(rootGroup('shapes')).toBe('shapes')
    expect(isSubgroup('shapes.round')).toBe(true)
    expect(isSubgroup('shapes')).toBe(false)
  })
})

describe('groupLineage', () => {
  test('lists the key and its ancestors, deepest first', () => {
    expect(groupLineage('shapes')).toEqual(['shapes'])
    expect(groupLineage('shapes.round')).toEqual(['shapes.round', 'shapes'])
  })
})

describe('leafGroups', () => {
  test('drops groups that have a descendant in the list', () => {
    expect(leafGroups(['shapes.round', 'shapes', 'tools'])).toEqual(['shapes.round', 'tools'])
    expect(leafGroups(['shapes', 'shapes.round', 'shapes.flat'])).toEqual([
      'shapes.round',
      'shapes.flat',
    ])
    expect(leafGroups(['shapes', 'tools', 'tools'])).toEqual(['shapes', 'tools'])
  })
})

describe('outerGroups', () => {
  test('drops groups whose ancestor is in the list', () => {
    expect(outerGroups(['shapes', 'shapes.round', 'tools'])).toEqual(['shapes', 'tools'])
    expect(outerGroups(['shapes.round', 'shapes.flat'])).toEqual(['shapes.round', 'shapes.flat'])
  })
})
