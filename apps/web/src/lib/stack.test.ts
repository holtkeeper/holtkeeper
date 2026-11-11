import { describe, expect, test } from 'bun:test'

import type { StackGroupView, StackUse } from '@holtkeeper/api'

import {
  conventionGrid,
  eolEntries,
  parseStackTab,
  otherTeamsStack,
  scopeStack,
  toolRows,
  versionLine,
  weeklyChanges,
} from './stack.ts'

const stackUse = (repo: string, fields: Partial<StackUse>): StackUse => ({
  repo,
  file: '.nvmrc',
  via: 'version-file',
  declared: fields.version ?? 'latest',
  lag: 'current',
  support: 'active',
  ...fields,
})

const shapes: StackGroupView = {
  forge: 'work',
  group: 'shapes',
  analysisId: 'a1',
  createdAt: '2026-11-10T00:00:00Z',
  checkedAt: '2026-11-10T00:00:00Z',
  soonDays: 180,
  repos: [
    { path: 'shapes/circle', groups: ['shapes'] },
    { path: 'shapes/square', groups: ['shapes'] },
  ],
  tools: [
    {
      id: 'node',
      name: 'Node.js',
      kind: 'runtime',
      latest: '26.1.0',
      latestLts: '24.11.0',
      uses: [
        stackUse('shapes/circle', {
          version: '18',
          cycle: '18',
          support: 'eol',
          eolDate: '2025-04-30',
        }),
        stackUse('shapes/square', { version: '24.3', cycle: '24', support: 'lts' }),
        stackUse('shapes/square', { file: 'Dockerfile', via: 'dockerfile', declared: 'lts' }),
      ],
    },
    {
      id: 'image:registry.test/shapes/base',
      name: 'registry.test/shapes/base',
      kind: 'image',
      uses: [stackUse('shapes/circle', { version: '2.3.0', support: 'unknown' })],
    },
  ],
  conventions: [
    { repo: 'shapes/circle', file: '.nvmrc', mode: 'exact', status: 'drifts', problems: ['x'] },
    { repo: 'shapes/square', file: '.nvmrc', mode: 'exact', status: 'matches', problems: [] },
    {
      repo: 'shapes/square',
      file: 'tsconfig.json',
      mode: 'json-subset',
      status: 'missing',
      problems: ['file is missing'],
    },
  ],
  changes: {
    since: '2026-11-03T00:00:00Z',
    newEol: 1,
    resolvedEol: 0,
    newDrifts: 1,
    resolvedDrifts: 2,
  },
}

const { changes: _, ...unchanged } = shapes

const colors: StackGroupView = {
  ...unchanged,
  group: 'colors',
  analysisId: 'a2',
  repos: [{ path: 'colors/red', groups: ['colors'] }],
  tools: [
    {
      id: 'node',
      name: 'Node.js',
      kind: 'runtime',
      latest: '26.1.0',
      uses: [
        stackUse('colors/red', {
          version: '22.4',
          cycle: '22',
          support: 'eol-soon',
          eolDate: '2027-04-30',
        }),
      ],
    },
  ],
  conventions: [],
}

test('unknown tabs fall back to runtimes', () => {
  expect(parseStackTab('conventions')).toBe('conventions')
  expect(parseStackTab('nope')).toBe('runtimes')
})

describe('scope', () => {
  test('my team keeps the home groups and counts the other teams', () => {
    const scoped = scopeStack([colors, shapes], 'mine', ['shapes'])
    expect(scoped.groups.map((group) => group.group)).toEqual(['shapes'])
    expect(scoped.counts).toEqual({ mine: 2, all: 3, others: 1 })
    expect(scoped.others).toEqual({ repos: 1, teams: 1 })
  })

  test('one group narrows everything to it whatever the switch says', () => {
    const scoped = scopeStack([colors, shapes], 'others', ['shapes'], 'colors')
    expect(scoped.groups.map((group) => group.group)).toEqual(['colors'])
    expect(scoped.groups[0]?.tools[0]?.uses).toHaveLength(1)
  })

  test('other teams fold into their own narrowed groups', () => {
    const folded = otherTeamsStack([colors, shapes], ['shapes'])
    expect(folded.groups.map((group) => group.group)).toEqual(['colors'])
    expect(folded.repos).toBe(1)
    expect(folded.teams).toEqual(['colors'])
    expect(otherTeamsStack([colors, shapes], [])).toEqual({ groups: [], repos: 0, teams: [] })
  })
})

test('version lines prefer the release line, then the major', () => {
  expect(versionLine({ cycle: '1.23', version: '1.23.4' })).toBe('1.23')
  expect(versionLine({ version: '2.3.0' })).toBe('2')
  expect(versionLine({ version: '1.4.4' })).toBe('1.4')
  expect(versionLine({})).toBe('floating')
})

test('tool rows merge groups, one cell per line with its worst support', () => {
  const rows = toolRows([shapes, colors])
  expect(rows.map((row) => [row.id, row.repos])).toEqual([
    ['node', 3],
    ['image:registry.test/shapes/base', 1],
  ])
  expect(rows[0]?.latestLts).toBe('24.11.0')
  expect(rows[0]?.versions.map((cell) => [cell.version, cell.support, cell.repos])).toEqual([
    ['18', 'eol', ['work:shapes/circle']],
    ['22', 'eol-soon', ['work:colors/red']],
    ['24', 'lts', ['work:shapes/square']],
    ['floating', 'active', ['work:shapes/square']],
  ])
})

test('end of life lists ended lines first with the fix to the newest supported line', () => {
  expect(
    eolEntries([colors, shapes]).map((entry) => [entry.key, entry.cycle, entry.support, entry.fix]),
  ).toEqual([
    ['work:shapes/circle', '18', 'eol', 'Node.js 18 → 24'],
    ['work:colors/red', '22', 'eol-soon', 'Node.js 22 → 26'],
  ])
})

test('the conventions grid puts failing repositories first and counts statuses', () => {
  const grid = conventionGrid([shapes])
  expect(grid.files).toEqual(['.nvmrc', 'tsconfig.json'])
  expect(grid.rows.map((row) => row.key)).toEqual(['work:shapes/circle', 'work:shapes/square'])
  expect(grid.rows[1]?.cells['tsconfig.json']).toMatchObject({
    status: 'missing',
    analysisId: 'a1',
  })
  expect(grid.rows[0]?.cells['tsconfig.json']).toBeUndefined()
  expect(grid.counts).toEqual({ matches: 1, drifts: 1, missing: 1, error: 0 })
})

test('weekly changes sum the groups that have an earlier record', () => {
  expect(weeklyChanges([colors])).toBeUndefined()
  expect(weeklyChanges([shapes, colors])).toEqual({
    since: '2026-11-03T00:00:00Z',
    newEol: 1,
    resolvedEol: 0,
    newDrifts: 1,
    resolvedDrifts: 2,
  })
})
