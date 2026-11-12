import { describe, expect, test } from 'bun:test'

import type { DependencyRepo, DependencyRow, UpgradeImpact } from '@holtkeeper/api'

import {
  behindLabel,
  behindTone,
  filterCounts,
  filterRows,
  librariesSort,
  libraryKey,
  librarySheetTabs,
  libraryTotals,
  narrowImpact,
  narrowRow,
  parseLibrariesSearch,
  parseLibraryKey,
  parseLibrarySearch,
  parseLibraryTab,
  rolloutTargets,
  scopeLibraryRows,
  sortRows,
  toCsv,
  upgradeVersions,
  withLibrariesSort,
} from './dependencies.ts'

const row = (name: string, fields: Partial<DependencyRow> = {}): DependencyRow => ({
  ecosystem: 'npm',
  name,
  internal: false,
  usedBy: [
    { repo: 'work:games/arcade', versions: ['1.0.0'] },
    { repo: 'work:tools/cli', versions: ['2.0.0'] },
  ],
  versions: [
    { version: '1.0.0', repos: 1, majorsBehind: 1 },
    { version: '2.0.0', repos: 1, majorsBehind: 0 },
  ],
  latest: '2.0.0',
  majorsBehind: 1,
  reposBehind: 1,
  advisories: { count: 0 },
  licenses: [],
  renovate: 'none',
  ...fields,
})

const rows = [
  row('widget-kit'),
  row('shape-lib', { majorsBehind: 0, advisories: { count: 2 }, renovate: 'open' }),
  row('example.com/gears', { ecosystem: 'Go', majorsBehind: 0 }),
  row('@acme/engine', { internal: true }),
]
const names = (list: DependencyRow[]) => list.map((item) => item.name)

describe('filterRows', () => {
  test('third-party by default, internal on its own', () => {
    expect(names(filterRows(rows, {}))).toEqual(['widget-kit', 'shape-lib', 'example.com/gears'])
    expect(names(filterRows(rows, { filter: 'internal' }))).toEqual(['@acme/engine'])
  })

  test('by query, ecosystem and the behind, advisories and updates filters', () => {
    expect(names(filterRows(rows, { query: 'KIT' }))).toEqual(['widget-kit'])
    expect(names(filterRows(rows, { ecosystem: 'Go' }))).toEqual(['example.com/gears'])
    expect(names(filterRows(rows, { filter: 'behind' }))).toEqual(['widget-kit'])
    expect(names(filterRows(rows, { filter: 'advisories' }))).toEqual(['shape-lib'])
    expect(names(filterRows(rows, { filter: 'updates' }))).toEqual(['shape-lib'])
  })

  test('one repository keeps only its versions', () => {
    const [only] = filterRows([row('widget-kit')], { repo: 'work:tools/cli' })
    expect(only?.usedBy).toEqual([{ repo: 'work:tools/cli', versions: ['2.0.0'] }])
    expect(only?.versions).toEqual([{ version: '2.0.0', repos: 1, majorsBehind: 0 }])
    expect(filterRows(rows, { repo: 'work:nowhere' })).toEqual([])
  })
})

test('behindTone', () => {
  expect([0, 1, 3].map(behindTone)).toEqual(['success', 'warning', 'danger'])
})

test('behindLabel', () => {
  expect([0, 1, 2].map(behindLabel)).toEqual(['current', '1 major behind', '2 majors behind'])
})

test("a filter applies to the repository's own versions", () => {
  expect(
    names(filterRows([row('widget-kit')], { repo: 'work:tools/cli', filter: 'behind' })),
  ).toEqual([])
  expect(
    names(filterRows([row('widget-kit')], { repo: 'work:games/arcade', filter: 'behind' })),
  ).toEqual(['widget-kit'])
})

describe('library keys and tabs', () => {
  test('round trip, scoped npm names and Go module paths included', () => {
    for (const library of [
      { ecosystem: 'npm' as const, name: '@acme/widget' },
      { ecosystem: 'Go' as const, name: 'example.com/gears/v2' },
    ])
      expect(parseLibraryKey(libraryKey(library))).toEqual(library)
  })

  test('unknown ecosystems and empty names are not libraries', () => {
    expect(parseLibraryKey('pypi:shapes')).toBeUndefined()
    expect(parseLibraryKey('npm:')).toBeUndefined()
    expect(parseLibraryKey('widget')).toBeUndefined()
    expect(parseLibraryKey(3)).toBeUndefined()
  })

  test('tabs fall back to overview', () => {
    expect(parseLibraryTab('upgrade')).toBe('upgrade')
    expect(parseLibraryTab('used-by')).toBe('used-by')
    expect(parseLibraryTab('matrix')).toBe('overview')
    expect(parseLibraryTab(undefined)).toBe('overview')
  })

  test('the sheet keeps overview, upgrade, used by and docs', () => {
    expect(librarySheetTabs.map((tab) => tab.id)).toEqual([
      'overview',
      'upgrade',
      'used-by',
      'docs',
    ])
    expect(parseLibraryTab('api', librarySheetTabs)).toBe('overview')
    expect(parseLibraryTab('docs', librarySheetTabs)).toBe('docs')
  })
})

describe('narrowRow', () => {
  test('recomputes versions and behind figures for the accepted repositories', () => {
    const narrowed = narrowRow(row('widget-kit'), (repo) => repo === 'work:tools/cli')
    expect(narrowed?.majorsBehind).toBe(0)
    expect(narrowed?.reposBehind).toBe(0)
    expect(narrowed?.versions).toEqual([{ version: '2.0.0', repos: 1, majorsBehind: 0 }])
  })

  test('keeps the row when every user is accepted and drops it when none is', () => {
    const full = row('widget-kit')
    expect(narrowRow(full, () => true)).toBe(full)
    expect(narrowRow(full, () => false)).toBeUndefined()
  })
})

const repoEntry = (path: string, groups: string[]): DependencyRepo => ({
  repo: { forge: 'work', path },
  groups,
  dependencies: 1,
})

describe('scopeLibraryRows', () => {
  const repos = [repoEntry('games/arcade', ['games']), repoEntry('tools/cli', ['tools', 'infra'])]
  const list = [
    row('widget-kit'),
    row('shape-lib', { usedBy: [{ repo: 'work:tools/cli', versions: ['2.0.0'] }] }),
  ]

  test('my teams narrows shared rows to its repositories and marks the rest as other teams', () => {
    const scoped = scopeLibraryRows(list, repos, 'mine', ['games'])
    expect(scoped.map((item) => [item.name, item.groups])).toEqual([
      ['widget-kit', ['games']],
      ['shape-lib', ['infra', 'tools']],
    ])
    expect(scoped[0]?.usedBy).toEqual([{ repo: 'work:games/arcade', versions: ['1.0.0'] }])
    expect(scoped[0]?.majorsBehind).toBe(1)
  })

  test('all keeps rows whole with the groups of a home-group user first', () => {
    const scoped = scopeLibraryRows(list, repos, 'all', ['games'])
    expect(scoped[0]?.usedBy).toHaveLength(2)
    expect(scoped[0]?.groups).toEqual(['games'])
  })

  test('a group keeps the libraries its repositories use, narrowed to them', () => {
    const scoped = scopeLibraryRows(list, repos, 'group:tools', ['games'])
    expect(scoped.map((item) => [item.name, item.groups])).toEqual([
      ['widget-kit', ['infra', 'tools']],
      ['shape-lib', ['infra', 'tools']],
    ])
    expect(scoped[0]?.usedBy).toEqual([{ repo: 'work:tools/cli', versions: ['2.0.0'] }])
  })

  test('without home groups rows stay whole', () => {
    expect(scopeLibraryRows(list, repos, 'mine', [])[0]?.usedBy).toHaveLength(2)
  })
})

describe('filterCounts', () => {
  test('segments ignore the segment, ecosystems ignore the ecosystem', () => {
    expect(filterCounts(rows, { ecosystem: 'npm', filter: 'advisories' })).toEqual({
      segments: { all: 2, behind: 1, advisories: 1, updates: 1, internal: 1 },
      ecosystems: { npm: 1, Go: 0 },
    })
    expect(filterCounts(rows, { query: 'gears' }).segments.all).toBe(1)
  })

  test('counts one repository by its own versions', () => {
    expect(filterCounts([row('widget-kit')], { repo: 'work:tools/cli' }).segments.behind).toBe(0)
  })
})

test('libraryTotals counts the rows and the repositories using them', () => {
  expect(
    libraryTotals([
      row('widget-kit', { renovate: 'broken' }),
      row('shape-lib', { majorsBehind: 0, advisories: { count: 1 }, renovate: 'open' }),
    ]),
  ).toEqual({
    libraries: 2,
    repos: 2,
    behindMajor: 1,
    withAdvisories: 1,
    renovateOpen: 1,
    renovateBroken: 1,
  })
})

describe('sortRows', () => {
  const list = [
    row('shape-lib', { majorsBehind: 0, reposBehind: 0, renovate: 'broken' }),
    row('widget-kit', { latest: undefined }),
    row('fooUtil', { majorsBehind: 2, reposBehind: 1 }),
  ]

  test('by name, behind and update state; unknown latest last', () => {
    expect(names(sortRows(list, { key: 'name', direction: 'asc' }))).toEqual([
      'fooUtil',
      'shape-lib',
      'widget-kit',
    ])
    expect(names(sortRows(list, { key: 'behind', direction: 'desc' }))).toEqual([
      'fooUtil',
      'shape-lib',
      'widget-kit',
    ])
    expect(names(sortRows(list, { key: 'updates', direction: 'desc' }))[0]).toBe('shape-lib')
    expect(sortRows(list, null)).toEqual(list)
  })

  test('search round trip', () => {
    expect(librariesSort({ sort: 'repos', dir: 'desc' })).toEqual({
      key: 'repos',
      direction: 'desc',
    })
    expect(librariesSort({})).toBeNull()
    expect(withLibrariesSort({ q: 'kit', sort: 'name', dir: 'asc' }, null)).toEqual({ q: 'kit' })
    expect(withLibrariesSort({}, { key: 'latest', direction: 'asc' })).toEqual({
      sort: 'latest',
      dir: 'asc',
    })
  })
})

describe('toCsv', () => {
  test('one line per library with a header, quoting and formula guards', () => {
    const csv = toCsv([
      row('widget-kit', {
        licenses: ['MIT', 'Apache-2.0'],
        advisories: { count: 1, severity: 'high' },
      }),
      row('=cmd', { latest: undefined, renovate: 'open', name: 'say "hi", =cmd' }),
    ])
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe(
      'Library,Ecosystem,Internal,Versions in use,Repositories,Latest,Majors behind,Repositories behind,Advisories,Worst severity,Update MRs,Licenses',
    )
    expect(lines[1]).toBe(
      'widget-kit,npm,no,1.0.0 x1; 2.0.0 x1,2,2.0.0,1,1,1,high,,MIT; Apache-2.0',
    )
    expect(lines[2]).toBe('"say ""hi"", =cmd",npm,no,1.0.0 x1; 2.0.0 x1,2,,,,0,,open,')
    expect(
      toCsv([row('=SUM(A1)')])
        .split('\r\n')[1]
        ?.startsWith("'=SUM(A1)"),
    ).toBe(true)
    expect(lines.at(-1)).toBe('')
  })
})

test('upgradeVersions offers used versions up and indexed versions plus latest down', () => {
  expect(
    upgradeVersions({
      versions: [
        { version: '1.2.0', repos: 1, majorsBehind: 2 },
        { version: '2.10.0', repos: 2, majorsBehind: 1 },
      ],
      indexed: [
        { version: '2.10.0', roles: ['used'] },
        { version: '2.9.0', roles: ['first'] },
      ],
      latest: '3.0.0',
    }),
  ).toEqual({ from: ['1.2.0', '2.10.0'], to: ['3.0.0', '2.10.0', '2.9.0'] })
})

test('narrowImpact drops repositories outside the scope and empty items', () => {
  const site = {
    file: 'src/a.ts',
    line: 1,
    column: 1,
    kind: 'call' as const,
    snippet: 'x',
    snippetLine: 1,
  }
  const impact: UpgradeImpact = {
    package: 'widget-kit',
    items: [
      {
        change: { change: 'removed', subpath: '.', name: 'spin' },
        level: 'breaking',
        repos: [
          { origin: 'work:games/arcade', versions: ['1.0.0'], count: 2, sites: [site] },
          { origin: 'work:tools/cli', versions: ['1.0.0'], count: 3, sites: [site] },
        ],
        count: 5,
      },
      {
        change: { change: 'deprecated', subpath: '.', name: 'wobble' },
        level: 'deprecated',
        repos: [{ origin: 'work:tools/cli', versions: ['1.0.0'], count: 1, sites: [site] }],
        count: 1,
      },
    ],
    affected: ['work:games/arcade', 'work:tools/cli'],
    unaffected: [],
  }
  const narrowed = narrowImpact(impact, (repo) => repo === 'work:games/arcade')
  expect(narrowed.items.map((item) => [item.change.name, item.count])).toEqual([['spin', 2]])
  expect(narrowed.affected).toEqual(['work:games/arcade'])
})

describe('rolloutTargets', () => {
  test('keeps repositories with a version below the target', () => {
    expect(
      rolloutTargets(
        [
          { repo: 'work:shapes/a', versions: ['1.9.0'] },
          { repo: 'work:shapes/b', versions: ['2.0.0'] },
          { repo: 'work:shapes/c', versions: ['2.1.0', '1.2.0'] },
          { repo: 'work:shapes/d', versions: ['2.10.0'] },
        ],
        '2.0.0',
      ),
    ).toEqual(['work:shapes/a', 'work:shapes/c'])
  })
})

describe('search parameters', () => {
  test('parseLibrariesSearch keeps known values and drops defaults', () => {
    expect(
      parseLibrariesSearch({
        repo: 'gitlab:acme/storefront',
        library: 'npm:some-lib',
        tab: 'upgrade',
        segment: 'behind',
        ecosystem: 'Go',
        q: 'widget',
        sort: 'repos',
        dir: 'desc',
      }),
    ).toEqual({
      repo: 'gitlab:acme/storefront',
      library: 'npm:some-lib',
      tab: 'upgrade',
      segment: 'behind',
      ecosystem: 'Go',
      q: 'widget',
      sort: 'repos',
      dir: 'desc',
    })
    expect(
      parseLibrariesSearch({ segment: 'all', ecosystem: 'PyPI', sort: 'size', q: '' }),
    ).toEqual({})
    expect(parseLibrariesSearch({ sort: 'name' })).toEqual({ sort: 'name', dir: 'asc' })
  })

  test('parseLibrarySearch keeps non-empty values', () => {
    expect(
      parseLibrarySearch({
        tab: 'used-by',
        export: 'createWidget',
        version: '',
        repo: 3,
        from: '3.9.1',
        to: '4.2.0',
      }),
    ).toEqual({ tab: 'used-by', export: 'createWidget', from: '3.9.1', to: '4.2.0' })
  })
})
