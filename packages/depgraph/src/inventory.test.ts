import { describe, expect, test } from 'bun:test'

import type { DepgraphData } from './analyze.ts'
import { directDependencies, fleetLibraries, ownPackages, versionDrift } from './inventory.ts'
import type { DepEdge, DepNode } from './model.ts'

const ws = (name: string, version?: string): DepNode => ({
  id: name,
  name,
  ...(version ? { version } : {}),
  ecosystem: 'npm',
  kind: 'workspace',
})
const pkg = (name: string, version: string, extra: Partial<DepNode> = {}): DepNode => ({
  id: `${name}@${version}`,
  name,
  version,
  ecosystem: 'npm',
  kind: 'package',
  ...extra,
})
const data = (nodes: DepNode[], edges: DepEdge[]): DepgraphData => ({
  layers: [
    {
      id: 'packages',
      source: 'test',
      graph: { nodes, edges },
      cycles: [],
      duplicates: [],
      stats: {} as DepgraphData['layers'][number]['stats'],
    },
  ],
  errors: [],
})

describe('directDependencies', () => {
  test('lists workspace edges to packages, strongest kind wins, transitive ones are skipped', () => {
    const result = directDependencies(
      data(
        [ws('app'), ws('lib'), pkg('react', '19.1.0'), pkg('debug', '4.4.3')],
        [
          { from: 'app', to: 'react@19.1.0', kind: 'dev' },
          { from: 'app', to: 'react@19.1.0', kind: 'prod' },
          { from: 'app', to: 'lib', kind: 'prod' },
          { from: 'react@19.1.0', to: 'debug@4.4.3', kind: 'prod' },
          { from: 'lib', to: 'react@19.1.0', kind: 'peer' },
        ],
      ),
    )
    expect(result).toEqual([
      { ecosystem: 'npm', name: 'react', version: '19.1.0', workspace: 'app', kind: 'prod' },
      { ecosystem: 'npm', name: 'react', version: '19.1.0', workspace: 'lib', kind: 'peer' },
    ])
  })

  test('uses the selected version where the resolver picks one', () => {
    const result = directDependencies(
      data(
        [
          ws('example.com/app'),
          pkg('golang.org/x/net', 'v0.20.0', { selected: false }),
          pkg('golang.org/x/net', 'v0.25.0', { selected: true }),
        ],
        [{ from: 'example.com/app', to: 'golang.org/x/net@v0.20.0', kind: 'prod' }],
      ),
    )
    expect(result.map((dep) => dep.version)).toEqual(['v0.25.0'])
  })
})

test('ownPackages lists versioned workspaces', () => {
  expect(ownPackages(data([ws('@acme/ui', '2.1.0'), ws('app')], []))).toEqual([
    { ecosystem: 'npm', name: '@acme/ui', version: '2.1.0' },
  ])
})

test('versionDrift follows semver compatibility', () => {
  expect(versionDrift(['1.2.3'])).toBe('none')
  expect(versionDrift(['1.2.3', '1.2.4'])).toBe('patch')
  expect(versionDrift(['1.2.3', '1.4.0'])).toBe('minor')
  expect(versionDrift(['1.2.3', '2.0.0'])).toBe('major')
  expect(versionDrift(['0.5.0', '0.5.2'])).toBe('patch')
  expect(versionDrift(['0.5.0', '0.6.0'])).toBe('major')
})

describe('fleetLibraries', () => {
  test('joins repositories, counts usages behind the newest version or the source', () => {
    const libraries = fleetLibraries([
      {
        origin: 'a',
        data: data(
          [ws('web'), pkg('react', '18.3.1'), pkg('@acme/ui', '2.0.0')],
          [
            { from: 'web', to: 'react@18.3.1', kind: 'prod' },
            { from: 'web', to: '@acme/ui@2.0.0', kind: 'prod' },
          ],
        ),
      },
      {
        origin: 'b',
        data: data(
          [ws('site'), pkg('react', '19.1.0')],
          [{ from: 'site', to: 'react@19.1.0', kind: 'prod' }],
        ),
      },
      { origin: 'c', data: data([ws('@acme/ui', '2.3.0')], []) },
    ])
    expect(libraries.map((l) => [l.name, l.drift, l.versions, l.behind])).toEqual([
      ['react', 'major', ['18.3.1', '19.1.0'], 1],
      ['@acme/ui', 'none', ['2.0.0'], 1],
    ])
    expect(libraries[0]?.usages.map((u) => [u.origin, u.lag])).toEqual([
      ['b', 'none'],
      ['a', 'major'],
    ])
    expect(libraries[1]?.latest).toBe('2.3.0')
    expect(libraries[1]?.usages[0]?.lag).toBe('minor')
    expect(libraries[1]?.source).toEqual({ origin: 'c', version: '2.3.0' })
  })
})
