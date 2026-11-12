import { describe, expect, test } from 'bun:test'

import type { StackGroupView, StackUse } from '@holtkeeper/api'

import {
  cellStatus,
  conventionGrid,
  conventionItems,
  cycleSupport,
  lineKey,
  matchingConvention,
  matrixCounts,
  monthYear,
  narrowStack,
  parseLineKey,
  parseStackSearch,
  parseStackTab,
  repoMatrix,
  scopeStack,
  sheetItems,
  suggestedSteps,
  versionLine,
  versionLines,
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
      cycles: [
        { cycle: '26', eol: '2029-04-30' },
        { cycle: '24', eol: '2028-04-30', lts: '2025-10-28', latest: '24.11.0' },
        { cycle: '23', eol: '2025-06-01' },
        { cycle: '22', eol: '2027-04-30', lts: true, latest: '22.21.0' },
        { cycle: '20', eol: '2026-04-30', lts: true, latest: '20.19.0' },
        { cycle: '18', eol: '2025-04-30', lts: true },
      ],
      uses: [
        stackUse('shapes/circle', {
          version: '18',
          cycle: '18',
          support: 'eol',
          eolDate: '2025-04-30',
        }),
        stackUse('shapes/circle', {
          file: 'Dockerfile',
          via: 'dockerfile',
          declared: '18-alpine',
          image: 'node:18-alpine',
          version: '18',
          cycle: '18',
          support: 'eol',
          eolDate: '2025-04-30',
        }),
        stackUse('shapes/square', { version: '24.3', cycle: '24', support: 'lts', lag: 'minor' }),
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

test('unknown views fall back to runtimes', () => {
  expect(parseStackTab('conventions')).toBe('conventions')
  expect(parseStackTab('eol')).toBe('runtimes')
})

describe('scope and filters', () => {
  test('my teams keeps the home groups', () => {
    const scoped = scopeStack([colors, shapes], 'mine', ['shapes'])
    expect(scoped.groups.map((group) => group.group)).toEqual(['shapes'])
    expect(scoped.counts).toEqual({ mine: 2, all: 3 })
  })

  test('one group narrows everything to it whatever the switch says', () => {
    const scoped = scopeStack([colors, shapes], 'mine', ['shapes'], 'colors')
    expect(scoped.groups.map((group) => group.group)).toEqual(['colors'])
    expect(scoped.groups[0]?.tools[0]?.uses).toHaveLength(1)
  })

  test('kind, group and repository filters narrow tools and repositories', () => {
    const images = narrowStack([shapes, colors], { kind: ['image'] })
    expect(images.flatMap((group) => group.tools.map((tool) => tool.id))).toEqual([
      'image:registry.test/shapes/base',
    ])
    expect(narrowStack([shapes, colors], { group: ['colors'] }).map((g) => g.group)).toEqual([
      'colors',
    ])
    const one = narrowStack([shapes, colors], { repo: 'work:shapes/square' })
    expect(one.map((group) => group.repos.map((repo) => repo.path))).toEqual([['shapes/square']])
    expect(one[0]?.conventions.map((result) => result.file)).toEqual(['.nvmrc', 'tsconfig.json'])
    expect(narrowStack([shapes], {})).toEqual([shapes])
  })
})

test('version lines prefer the release line, then the major', () => {
  expect(versionLine({ cycle: '1.23', version: '1.23.4' })).toBe('1.23')
  expect(versionLine({ version: '2.3.0' })).toBe('2')
  expect(versionLine({ version: '1.4.4' })).toBe('1.4')
  expect(versionLine({})).toBe('floating')
})

test('versionLines merges groups, one cell per line with its worst support', () => {
  const rows = versionLines([shapes, colors])
  expect(rows.map((row) => [row.id, row.repos])).toEqual([
    ['node', 3],
    ['image:registry.test/shapes/base', 1],
  ])
  expect(rows[0]?.latestLts).toBe('24.11.0')
  expect(rows[0]?.cycles).toHaveLength(6)
  expect(
    rows[0]?.versions.map((cell) => [cell.version, cell.support, cell.repos, cell.eolDate]),
  ).toEqual([
    ['18', 'eol', ['work:shapes/circle'], '2025-04-30'],
    ['22', 'eol-soon', ['work:colors/red'], '2027-04-30'],
    ['24', 'lts', ['work:shapes/square'], undefined],
    ['floating', 'active', ['work:shapes/square'], undefined],
  ])
})

describe('cell status', () => {
  test('ended and ending lines come first, then how far behind', () => {
    expect(cellStatus({ support: 'eol', lag: 'major' })).toEqual({
      label: 'End of life',
      tone: 'danger',
    })
    expect(cellStatus({ support: 'eol-soon', lag: 'current', eolDate: '2027-04-30' })).toEqual({
      label: 'Ends Apr 2027',
      tone: 'warning',
    })
    expect(cellStatus({ support: 'active', lag: 'major' }).label).toBe('Major behind')
    expect(cellStatus({ support: 'lts', lag: 'patch' }).label).toBe('LTS')
    expect(cellStatus({ support: 'active', lag: 'current' }).label).toBe('Latest')
    expect(cellStatus({ support: 'unknown', lag: 'unknown' }).tone).toBe('default')
  })

  test('monthYear does not depend on the locale', () => {
    expect(monthYear('2027-01-15')).toBe('Jan 2027')
    expect(monthYear('soon')).toBe('soon')
  })
})

describe('repoMatrix', () => {
  test('one cell per repository and tool, worst use shown, worst repositories first', () => {
    const matrix = repoMatrix([colors, shapes])
    expect(matrix.tools.map((tool) => tool.id)).toEqual(['node', 'image:registry.test/shapes/base'])
    expect(matrix.rows.map((row) => [row.key, row.worst])).toEqual([
      ['work:shapes/circle', 'eol'],
      ['work:colors/red', 'eol-soon'],
      ['work:shapes/square', 'lts'],
    ])
    const circle = matrix.rows[0]?.cells.node
    expect(circle?.line).toBe('18')
    expect(circle?.uses.map((use) => use.file)).toEqual(['.nvmrc', 'Dockerfile'])
    const square = matrix.rows[2]?.cells.node
    expect([square?.version, square?.status.label]).toEqual(['24.3', 'Minor behind'])
    expect(matrix.rows[2]?.cells['image:registry.test/shapes/base']).toBeUndefined()
  })

  test('a segment keeps only its cells, repositories and tools', () => {
    const matrix = repoMatrix([colors, shapes], 'eol')
    expect(matrix.tools.map((tool) => tool.id)).toEqual(['node'])
    expect(matrix.rows.map((row) => row.key)).toEqual(['work:shapes/circle'])
  })

  test('repositories without uses stay without a segment', () => {
    const empty: StackGroupView = { ...colors, tools: [] }
    expect(repoMatrix([empty]).rows.map((row) => Object.keys(row.cells).length)).toEqual([0])
    expect(repoMatrix([empty], 'eol').rows).toEqual([])
  })

  test('counts sum cells and repositories at or near end of life', () => {
    expect(matrixCounts(repoMatrix([colors, shapes]))).toEqual({
      repos: 3,
      cells: 4,
      eol: 1,
      eolRepos: 1,
      eolSoon: 1,
    })
  })
})

describe('suggestedSteps', () => {
  const node = versionLines([shapes])[0]!
  const now = new Date('2026-11-10T00:00:00Z')

  test('the newest LTS release and the nearest newer LTS line that has not ended', () => {
    expect(suggestedSteps(node, '18', now)).toEqual([
      { kind: 'suggested', line: '24', version: '24.11.0', support: 'lts', eolDate: '2028-04-30' },
      {
        kind: 'smaller',
        line: '22',
        version: '22.21.0',
        support: 'eol-soon',
        eolDate: '2027-04-30',
      },
    ])
  })

  test('nothing for the newest line, only the target without lines or a version', () => {
    expect(suggestedSteps(node, '24', now)).toEqual([])
    expect(suggestedSteps({ latest: '3.1.0' }, '2', now)).toEqual([
      { kind: 'suggested', line: '3', version: '3.1.0', support: 'active' },
    ])
    expect(suggestedSteps(node, 'floating', now).map((step) => step.kind)).toEqual(['suggested'])
    expect(suggestedSteps({}, '2', now)).toEqual([])
  })

  test('cycle support follows the dates', () => {
    expect(cycleSupport({ cycle: '1', eol: true }, now, 180)).toBe('eol')
    expect(cycleSupport({ cycle: '1', eol: '2027-01-01' }, now, 180)).toBe('eol-soon')
    expect(cycleSupport({ cycle: '1', eol: false, lts: '2027-01-01' }, now, 180)).toBe('active')
    expect(cycleSupport({ cycle: '1', eol: false, lts: true }, now, 180)).toBe('lts')
  })
})

test('the matching convention is the one of a file the line is declared in, failing first', () => {
  expect(
    matchingConvention([shapes], 'work:shapes/circle', ['.nvmrc', 'Dockerfile']),
  ).toMatchObject({ file: '.nvmrc', status: 'drifts', analysisId: 'a1', group: 'shapes' })
  expect(matchingConvention([shapes], 'work:shapes/circle', ['Dockerfile'])).toBeUndefined()
})

test('line keys keep tool ids with colons', () => {
  expect(parseLineKey(lineKey('image:registry.test/shapes/base', '2'))).toEqual({
    toolId: 'image:registry.test/shapes/base',
    line: '2',
  })
  expect(parseLineKey('node')).toBeUndefined()
  expect(parseLineKey('node:')).toBeUndefined()
  expect(parseLineKey(undefined)).toBeUndefined()
})

test('the sheet steps through cells from the matrix and lines from the table', () => {
  const groups = [colors, shapes]
  const matrix = repoMatrix(groups)
  const lines = versionLines(groups)
  expect(sheetItems(matrix, lines, true)).toEqual([
    { line: 'node:18', repo: 'work:shapes/circle' },
    { line: 'image:registry.test/shapes/base:2', repo: 'work:shapes/circle' },
    { line: 'node:22', repo: 'work:colors/red' },
    { line: 'node:24', repo: 'work:shapes/square' },
  ])
  expect(sheetItems(matrix, lines, false).map((item) => item.line)).toEqual([
    'node:18',
    'node:22',
    'node:24',
    'node:floating',
    'image:registry.test/shapes/base:2',
  ])
})

test('the conventions grid puts failing repositories first and counts statuses', () => {
  const grid = conventionGrid([shapes])
  expect(grid.files).toEqual(['.nvmrc', 'tsconfig.json'])
  expect(grid.rows.map((row) => [row.key, row.groups])).toEqual([
    ['work:shapes/circle', ['shapes']],
    ['work:shapes/square', ['shapes']],
  ])
  expect(grid.rows[1]?.cells['tsconfig.json']).toMatchObject({
    status: 'missing',
    analysisId: 'a1',
  })
  expect(grid.rows[0]?.cells['tsconfig.json']).toBeUndefined()
  expect(grid.counts).toEqual({ matches: 1, drifts: 1, missing: 1, error: 0 })
  expect(conventionItems(grid).map((result) => `${result.repo} ${result.file}`)).toEqual([
    'shapes/circle .nvmrc',
    'shapes/square .nvmrc',
    'shapes/square tsconfig.json',
  ])
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

test('parseStackSearch keeps known values and drops the rest', () => {
  expect(
    parseStackSearch({
      tab: 'conventions',
      segment: 'eol',
      kind: 'runtime,image,robot',
      group: 'Web,Payments',
      line: 'node:20',
      repo: 'gitlab:acme/storefront',
      pane: 'cell',
    }),
  ).toEqual({
    tab: 'conventions',
    segment: 'eol',
    kind: ['runtime', 'image'],
    group: ['Web', 'Payments'],
    line: 'node:20',
    repo: 'gitlab:acme/storefront',
    pane: 'cell',
  })
  expect(parseStackSearch({ segment: 'lts', kind: '', tab: '', pane: 'history' })).toEqual({})
})
