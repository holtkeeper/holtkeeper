import { describe, expect, test } from 'bun:test'

import { analyzeDependencies } from './analyze.ts'
import { depgraphDataSchema } from './analyze.ts'
import { findCycles } from './cycles.ts'
import { findDuplicates } from './duplicates.ts'
import type { DepEdge, DepGraph, DepNode } from './model.ts'
import { graphStats } from './stats.ts'
import { compareVersions } from './version.ts'

const ws = (id: string): DepNode => ({ id, name: id, ecosystem: 'npm', kind: 'workspace' })
const pkg = (name: string, version: string): DepNode => ({
  id: `${name}@${version}`,
  name,
  version,
  ecosystem: 'npm',
  kind: 'package',
})
const edges = (...pairs: [string, string][]): DepEdge[] =>
  pairs.map(([from, to]) => ({ from, to, kind: 'prod' }))

describe('findCycles', () => {
  test('returns one shortest closed path per strongly connected component', () => {
    const graph: DepGraph = {
      nodes: ['a', 'b', 'c', 'd', 'e', 'f'].map(ws),
      edges: edges(
        ['a', 'b'],
        ['b', 'c'],
        ['c', 'a'],
        ['c', 'd'],
        ['d', 'b'],
        ['e', 'e'],
        ['a', 'f'],
      ),
    }
    expect(findCycles(graph)).toEqual([
      { members: ['a', 'b', 'c', 'd'], path: ['a', 'b', 'c', 'a'] },
      { members: ['e'], path: ['e', 'e'] },
    ])
  })

  test('prefers the shortest cycle in a component', () => {
    const graph: DepGraph = {
      nodes: ['a', 'b', 'c', 'd'].map(ws),
      edges: edges(['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'a'], ['c', 'b']),
    }
    expect(findCycles(graph)).toEqual([{ members: ['a', 'b', 'c', 'd'], path: ['b', 'c', 'b'] }])
  })

  test('handles deep acyclic chains without recursion', () => {
    const ids = Array.from({ length: 50_000 }, (_, i) => `n${i}`)
    const graph: DepGraph = {
      nodes: ids.map(ws),
      edges: edges(...ids.slice(1).map((id, i): [string, string] => [ids[i] as string, id])),
    }
    expect(findCycles(graph)).toEqual([])
  })
})

describe('findDuplicates', () => {
  const graph: DepGraph = {
    nodes: [
      ws('app'),
      ws('lib'),
      pkg('express', '4.21.0'),
      pkg('debug', '2.6.9'),
      pkg('debug', '4.4.3'),
      pkg('ms', '2.1.3'),
    ],
    edges: edges(
      ['app', 'lib'],
      ['app', 'debug@4.4.3'],
      ['lib', 'express@4.21.0'],
      ['express@4.21.0', 'debug@2.6.9'],
      ['debug@4.4.3', 'ms@2.1.3'],
    ),
  }

  test('reports every version with dependents and a shortest path from a workspace', () => {
    expect(findDuplicates(graph)).toEqual([
      {
        ecosystem: 'npm',
        name: 'debug',
        versions: [
          {
            version: '2.6.9',
            id: 'debug@2.6.9',
            dependents: ['express@4.21.0'],
            path: ['lib', 'express@4.21.0', 'debug@2.6.9'],
          },
          {
            version: '4.4.3',
            id: 'debug@4.4.3',
            dependents: ['app'],
            path: ['app', 'debug@4.4.3'],
          },
        ],
      },
    ])
  })

  test('keeps the selected flag and ignores other ecosystems', () => {
    const go: DepGraph = {
      nodes: [
        { id: 'm', name: 'm', ecosystem: 'Go', kind: 'workspace' },
        {
          id: 'x@v1.0.0',
          name: 'x',
          version: 'v1.0.0',
          ecosystem: 'Go',
          kind: 'package',
          selected: false,
        },
        {
          id: 'x@v1.2.0',
          name: 'x',
          version: 'v1.2.0',
          ecosystem: 'Go',
          kind: 'package',
          selected: true,
        },
        { id: 'npm-x', name: 'x', version: '3.0.0', ecosystem: 'npm', kind: 'package' },
      ],
      edges: edges(['m', 'x@v1.2.0'], ['m', 'x@v1.0.0']),
    }
    expect(
      findDuplicates(go).map((duplicate) => duplicate.versions.map((v) => [v.version, v.selected])),
    ).toEqual([
      [
        ['v1.0.0', false],
        ['v1.2.0', true],
      ],
    ])
  })
})

describe('graphStats', () => {
  test('counts direct and transitive dependencies and finds the deepest chain', () => {
    const graph: DepGraph = {
      nodes: [ws('app'), pkg('a', '1.0.0'), pkg('b', '1.0.0'), pkg('c', '1.0.0')],
      edges: edges(
        ['app', 'a@1.0.0'],
        ['a@1.0.0', 'b@1.0.0'],
        ['b@1.0.0', 'c@1.0.0'],
        ['app', 'c@1.0.0'],
      ),
    }
    const stats = graphStats(graph, { top: 2 })
    expect(stats).toMatchObject({
      nodes: 4,
      edges: 4,
      byKind: { workspace: 1, package: 3 },
      byEcosystem: { npm: 4 },
      direct: 2,
      transitive: 1,
      mostDependedOn: [
        { id: 'c@1.0.0', dependents: 2 },
        { id: 'a@1.0.0', dependents: 1 },
      ],
      deepestChain: ['app', 'a@1.0.0', 'b@1.0.0'],
    })
  })
})

describe('analyzeDependencies', () => {
  test('runs detected sources, records failures and produces valid data', async () => {
    const data = await analyzeDependencies({
      dir: '/repo',
      sources: [
        {
          name: 'fake',
          detect: async () => true,
          load: async () => [
            {
              id: 'workspaces',
              source: 'fake',
              graph: { nodes: [ws('a'), ws('b')], edges: edges(['a', 'b'], ['b', 'a']) },
            },
          ],
        },
        {
          name: 'absent',
          detect: async () => false,
          load: () => Promise.reject(new Error('not called')),
        },
        { name: 'broken', detect: async () => true, load: () => Promise.reject(new Error('boom')) },
      ],
    })
    expect(data.layers).toHaveLength(1)
    expect(data.layers[0]?.cycles).toEqual([{ members: ['a', 'b'], path: ['a', 'b', 'a'] }])
    expect(data.errors).toEqual([{ source: 'broken', message: 'boom' }])
    expect(depgraphDataSchema.parse(JSON.parse(JSON.stringify(data)))).toEqual(data)
  })
})

test('compareVersions orders semver and Go versions', () => {
  expect(
    ['v1.10.0', 'v1.2.0', '1.2.0-beta.2', '1.2.0-beta.10', 'v0.3.0'].toSorted(compareVersions),
  ).toEqual(['v0.3.0', '1.2.0-beta.2', '1.2.0-beta.10', 'v1.2.0', 'v1.10.0'])
})
