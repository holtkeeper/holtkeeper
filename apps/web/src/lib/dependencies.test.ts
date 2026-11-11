import { describe, expect, test } from 'bun:test'

import type { DependencyRepo, DependencyRow, UpgradeImpact } from '@holtkeeper/api'

import {
  behindLabel,
  behindTone,
  filterRows,
  libraryKey,
  narrowImpact,
  narrowRow,
  otherTeamRows,
  parseLibraryKey,
  parseLibraryTab,
  rolloutTargets,
  scopeRows,
  tileCounts,
  upgradeVersions,
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
    expect(parseLibraryTab('matrix')).toBe('overview')
    expect(parseLibraryTab(undefined)).toBe('overview')
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

describe('scopeRows', () => {
  const repos = [repoEntry('games/arcade', ['games']), repoEntry('tools/cli', ['tools', 'infra'])]
  const list = [
    row('widget-kit'),
    row('shape-lib', { usedBy: [{ repo: 'work:tools/cli', versions: ['2.0.0'] }] }),
  ]

  test('my team narrows rows to its repositories and counts the rest', () => {
    const scoped = scopeRows(list, repos, 'mine', ['games'])
    expect(names(scoped.shown)).toEqual(['widget-kit'])
    expect(scoped.shown[0]?.usedBy).toEqual([{ repo: 'work:games/arcade', versions: ['1.0.0'] }])
    expect(scoped.counts).toEqual({ mine: 1, all: 2, others: 2 })
    expect(scoped.others).toEqual({ libraries: 2, repos: 1, teams: 2 })
  })

  test('all keeps every row whole; other teams shows counts only', () => {
    expect(scopeRows(list, repos, 'all', ['games']).shown).toEqual(list)
    expect(scopeRows(list, repos, 'others', ['games']).shown).toEqual([])
  })

  test('without home groups everything belongs to other teams', () => {
    expect(scopeRows(list, repos, 'mine', []).counts).toEqual({ mine: 0, all: 2, others: 2 })
  })
})

describe('otherTeamRows', () => {
  const repos = [repoEntry('games/arcade', ['games']), repoEntry('tools/cli', ['tools', 'infra'])]
  const list = [
    row('widget-kit'),
    row('shape-lib', { usedBy: [{ repo: 'work:tools/cli', versions: ['2.0.0'] }] }),
  ]

  test('folds libraries only other teams use, narrowed to their repositories', () => {
    const folded = otherTeamRows(list, repos, ['games'])
    expect(names(folded.rows)).toEqual(['shape-lib'])
    expect(folded.rows[0]?.usedBy).toEqual([{ repo: 'work:tools/cli', versions: ['2.0.0'] }])
    expect(folded.teams).toEqual(['infra', 'tools'])
  })

  test('folds nothing without home groups', () => {
    expect(otherTeamRows(list, repos, [])).toEqual({ rows: [], teams: [] })
  })
})

test('tileCounts counts third-party rows only', () => {
  expect(
    tileCounts([
      row('widget-kit', { renovate: 'broken' }),
      row('shape-lib', { majorsBehind: 0, advisories: { count: 1 }, renovate: 'open' }),
      row('@acme/engine', { internal: true, advisories: { count: 3 } }),
    ]),
  ).toEqual({ behindMajor: 1, withAdvisories: 1, renovateOpen: 1, renovateBroken: 1 })
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
