import { describe, expect, test } from 'bun:test'

import { analyzeLayer } from './analyze.ts'
import type { DepgraphData } from './analyze.ts'
import type { DepGraph, DepNode } from './model.ts'
import { depgraphAnalysis } from './report.ts'

const ws = (id: string): DepNode => ({
  id,
  name: id,
  ecosystem: 'npm',
  kind: 'workspace',
  path: `packages/${id}`,
})
const pkg = (name: string, version: string): DepNode => ({
  id: `${name}@${version}`,
  name,
  version,
  ecosystem: 'npm',
  kind: 'package',
})
const edge = (from: string, to: string, kind: 'prod' | 'dev' = 'prod') => ({ from, to, kind })

function data(duplicated: string): DepgraphData {
  const workspaces: DepGraph = {
    nodes: [ws('a'), ws('b'), ws('c')],
    edges: [edge('a', 'b'), edge('b', 'c'), edge('c', 'a', 'dev')],
  }
  const packages: DepGraph = {
    nodes: [
      ...workspaces.nodes,
      pkg(duplicated, '1.0.0'),
      pkg(duplicated, '2.0.0'),
      pkg('wrap', '1.0.0'),
    ],
    edges: [
      ...workspaces.edges,
      edge('a', `${duplicated}@2.0.0`),
      edge('c', 'wrap@1.0.0'),
      edge('wrap@1.0.0', `${duplicated}@1.0.0`),
    ],
  }
  return {
    layers: [
      analyzeLayer({ id: 'workspaces', source: 'package.json', graph: workspaces }),
      analyzeLayer({ id: 'packages', source: 'bun.lock', graph: packages }),
    ],
    errors: [],
  }
}

const record = (ref: string, payload: DepgraphData) => ({
  id: ref,
  repo: { forge: 'gitlab', path: 'games/app' } as never,
  kind: 'depgraph',
  ref,
  createdAt: '2026-10-01T00:00:00.000Z',
  data: payload,
})

describe('depgraphAnalysis', () => {
  const report = depgraphAnalysis.toReport(record('v2', data('debug')), record('v1', data('ms')))

  test('validates its data', () => {
    const payload = data('debug')
    expect(depgraphAnalysis.schema.parse(JSON.parse(JSON.stringify(payload)))).toEqual(payload)
    expect(() => depgraphAnalysis.schema.parse({ layers: [{ id: 'nope' }], errors: [] })).toThrow()
  })

  test('shows headline numbers with deltas where lower is better', () => {
    expect(report.subject).toEqual({
      repo: { forge: 'gitlab', path: 'games/app' },
      ref: 'v2',
      compareTo: 'v1',
    })
    expect(
      report.metrics.map(({ id, value, delta, better, tone }) => ({
        id,
        value,
        delta,
        better,
        tone,
      })),
    ).toEqual([
      { id: 'workspaces', value: 3, delta: 0, better: undefined, tone: undefined },
      { id: 'packages', value: 3, delta: 0, better: undefined, tone: undefined },
      { id: 'duplicates', value: 1, delta: 0, better: 'down', tone: 'warning' },
      { id: 'workspace-cycles', value: 1, delta: 0, better: 'down', tone: 'bad' },
      { id: 'module-cycles', value: 0, delta: 0, better: 'down', tone: 'good' },
    ])
    expect(
      depgraphAnalysis.summarize(data('x')).every((metric) => metric.delta === undefined),
    ).toBe(true)
  })

  test('lists cycles and duplicates as issues with their paths', () => {
    expect(report.sections.map((section) => section.id)).toEqual([
      'issues',
      'workspaces',
      'duplicates',
      'most-used',
      'overview',
    ])
    const [issues] = report.sections[0]?.blocks ?? []
    expect(issues).toEqual({
      type: 'issues',
      items: [
        {
          id: 'workspaces-package.json-cycle-0',
          tone: 'bad',
          title: 'Workspace cycle: a → b → c → a',
          tags: ['package.json'],
        },
        {
          id: 'duplicate-npm:debug',
          tone: 'warning',
          title: 'debug in 2 versions: 1.0.0, 2.0.0',
          detail: '1.0.0: c → wrap@1.0.0 → debug@1.0.0\n2.0.0: a → debug@2.0.0',
          tags: ['npm', 'bun.lock'],
        },
      ],
    })
  })

  test('draws the workspace graph with the cycle highlighted', () => {
    const [graph] = report.sections[1]?.blocks ?? []
    expect(graph).toMatchObject({
      type: 'graph',
      layout: 'layered',
      highlight: [['a', 'b', 'c', 'a']],
      edges: [
        { from: 'a', to: 'b', tone: 'bad' },
        { from: 'b', to: 'c', tone: 'bad' },
        { from: 'c', to: 'a', label: 'dev', dashed: true, tone: 'bad' },
      ],
    })
  })

  test('tables duplicates and what changed since the previous record', () => {
    const [table, changes] = report.sections[2]?.blocks ?? []
    expect(table?.type === 'table' ? table.rows : []).toEqual([
      {
        library: 'debug',
        version: '1.0.0',
        pulledInBy: 'wrap@1.0.0',
        path: 'c → wrap@1.0.0 → debug@1.0.0',
      },
      { library: 'debug', version: '2.0.0', pulledInBy: 'a', path: 'a → debug@2.0.0' },
    ])
    expect(changes).toMatchObject({
      type: 'table',
      title: 'Since v1',
      rows: [
        { library: 'debug', status: { text: 'new', tone: 'warning' }, versions: '1.0.0, 2.0.0' },
        { library: 'ms', status: { text: 'resolved', tone: 'good' }, versions: '1.0.0, 2.0.0' },
      ],
    })
  })

  test('summarizes packages by ecosystem', () => {
    const chart = report.sections.at(-1)?.blocks[1]
    expect(chart).toMatchObject({
      type: 'chart',
      data: [{ ecosystem: 'npm', workspace: 3, package: 3, module: 0 }],
    })
  })
})
