import { describe, expect, test } from 'bun:test'

import {
  type Library,
  filterLibraries,
  inventoryTotals,
  matrixRow,
  versionBreakdown,
  worstLag,
} from './dependencies.ts'

const react: Library = {
  ecosystem: 'npm',
  name: 'react',
  versions: ['18.3.1', '19.1.0'],
  latest: '19.1.0',
  drift: 'major',
  behind: 2,
  usages: [
    { origin: 'work:b', workspace: 'site', version: '19.1.0', kind: 'prod', lag: 'none' },
    { origin: 'work:a', workspace: 'web', version: '18.3.1', kind: 'prod', lag: 'major' },
    { origin: 'work:a', workspace: 'docs', version: '18.3.1', kind: 'dev', lag: 'major' },
  ],
}
const zod: Library = {
  ecosystem: 'npm',
  name: 'zod',
  versions: ['4.1.0'],
  latest: '4.1.0',
  drift: 'none',
  behind: 0,
  usages: [{ origin: 'work:a', workspace: 'web', version: '4.1.0', kind: 'prod', lag: 'none' }],
}

describe('filterLibraries', () => {
  test('filters by name, drift and lag', () => {
    expect(filterLibraries([react, zod], { query: 'ZO' }).map((l) => l.name)).toEqual(['zod'])
    expect(filterLibraries([react, zod], { filter: 'drifting' }).map((l) => l.name)).toEqual([
      'react',
    ])
    expect(filterLibraries([react, zod], { filter: 'major' }).map((l) => l.name)).toEqual(['react'])
  })

  test('drops dev usages and other repositories, recounting what is behind', () => {
    const [only] = filterLibraries([react], { includeDev: false, repo: 'work:a' })
    expect(only?.usages.map((u) => u.workspace)).toEqual(['web'])
    expect(only?.behind).toBe(1)
    expect(only?.versions).toEqual(['18.3.1'])
    expect(filterLibraries([react], { repo: 'work:c' })).toEqual([])
  })
})

test('versionBreakdown counts usages and repositories per version, newest first', () => {
  expect(versionBreakdown(react)).toEqual([
    { version: '19.1.0', count: 1, lag: 'none', repos: 1 },
    { version: '18.3.1', count: 2, lag: 'major', repos: 1 },
  ])
})

test('matrixRow groups workspaces per repository and version', () => {
  const row = matrixRow(react)
  expect(row.get('work:a')).toEqual({
    versions: [{ version: '18.3.1', lag: 'major', workspaces: ['web', 'docs'] }],
  })
  expect(row.get('work:b')?.versions[0]?.lag).toBe('none')
})

test('worstLag and inventoryTotals', () => {
  expect(worstLag(['patch', 'major', 'none'])).toBe('major')
  expect(worstLag([])).toBe('none')
  expect(inventoryTotals([react, zod])).toEqual({
    libraries: 2,
    drifting: 1,
    major: 1,
    behind: 2,
    usages: 4,
  })
})
