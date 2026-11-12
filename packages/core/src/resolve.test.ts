import { describe, expect, test } from 'bun:test'

import type { ForgeDefinition } from '@holtkeeper/forge'

import { parseConfig } from './config.ts'
import { resolveRepo } from './resolve.ts'

const forge: ForgeDefinition = {
  kind: 'fake',
  url: 'https://forge.test',
  create: () => {
    throw new Error('not used')
  },
}

const config = parseConfig({
  forges: { work: forge },
  groups: {
    'shapes.round': { forge: 'work', include: ['shapes/circle-*', 'other/circle-*'] },
    shapes: { forge: 'work', include: ['shapes/*'], exclude: ['shapes/legacy-*'] },
    tools: { forge: 'work', include: ['shapes/circle-*'] },
    'shapes.flat': { forge: 'work', include: ['shapes/**'], exclude: ['shapes/circle-big'] },
  },
})

const groupsOf = (path: string) => resolveRepo(config, { forge: 'work', path }).groups

describe('resolveRepo with subgroups', () => {
  test('lists each subgroup directly before its parent', () => {
    expect(groupsOf('shapes/circle-small')).toEqual([
      'shapes.round',
      'shapes.flat',
      'shapes',
      'tools',
    ])
    expect(groupsOf('shapes/circle-big')).toEqual(['shapes.round', 'shapes', 'tools'])
    expect(groupsOf('shapes/square')).toEqual(['shapes.flat', 'shapes'])
  })

  test('keeps a subgroup within its parent', () => {
    expect(groupsOf('other/circle-a')).toEqual([])
    expect(groupsOf('shapes/legacy-circle')).toEqual([])
    expect(groupsOf('shapes/a/b')).toEqual([])
  })
})
