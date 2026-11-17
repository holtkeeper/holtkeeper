import { describe, expect, test } from 'bun:test'

import { type DepNode, analyzeLayer } from '@holtkeeper/depgraph'

import { inventoryOf } from './inventory.ts'

const layer = (id: 'workspaces' | 'packages', source: string, nodes: DepNode[]) =>
  analyzeLayer({ id, source, graph: { nodes, edges: [] } })

const pkg = (name: string, version: string, extra: Partial<DepNode> = {}): DepNode => ({
  id: `${name}@${version}`,
  name,
  version,
  ecosystem: extra.ecosystem ?? 'npm',
  kind: 'package',
  ...extra,
})

const go = (name: string, version: string, selected?: boolean) =>
  pkg(name, version, { ecosystem: 'Go', ...(selected !== undefined && { selected }) })

describe('inventoryOf', () => {
  test('lists npm packages with their lockfile, skipping workspaces and non-registry versions', () => {
    const inventory = inventoryOf(
      {
        layers: [
          layer('workspaces', 'package.json', [
            { id: 'app', name: 'app', ecosystem: 'npm', kind: 'workspace' },
          ]),
          layer('packages', 'pnpm-lock.yaml', [
            { id: 'app', name: 'app', version: '1.0.0', ecosystem: 'npm', kind: 'workspace' },
            pkg('some-lib', '1.2.3'),
            pkg('other-lib', '2.0.0-beta.1'),
            pkg('linked', 'link:../linked'),
            pkg('@acme/widgets', '3.0.0'),
          ]),
        ],
        errors: [],
      },
      { isInternal: (ecosystem, name) => ecosystem === 'npm' && name === '@acme/widgets' },
    )
    expect(inventory).toEqual({
      packages: [
        { ecosystem: 'npm', name: 'some-lib', version: '1.2.3', source: 'pnpm-lock.yaml' },
        { ecosystem: 'npm', name: 'other-lib', version: '2.0.0-beta.1', source: 'pnpm-lock.yaml' },
      ],
    })
  })

  test('keeps selected Go versions without the v prefix and names the go.mod per module', () => {
    const inventory = inventoryOf({
      layers: [
        layer('workspaces', 'go.mod', [
          {
            id: 'example.com/a',
            name: 'example.com/a',
            ecosystem: 'Go',
            kind: 'workspace',
            path: '.',
          },
          {
            id: 'example.com/b',
            name: 'example.com/b',
            ecosystem: 'Go',
            kind: 'workspace',
            path: 'tools/b',
          },
        ]),
        layer('packages', 'go mod graph (.)', [
          go('example.com/dep', 'v1.4.0', true),
          go('example.com/dep', 'v1.2.0', false),
        ]),
        layer('packages', 'go mod graph (tools/b)', [
          go('example.com/other', 'v0.0.0-20260101000000-abcdef123456'),
        ]),
      ],
      errors: [],
    })
    expect(inventory.packages).toEqual([
      { ecosystem: 'Go', name: 'example.com/dep', version: '1.4.0', source: 'go.mod' },
      {
        ecosystem: 'Go',
        name: 'example.com/other',
        version: '0.0.0-20260101000000-abcdef123456',
        source: 'tools/b/go.mod',
      },
    ])
  })

  test('a single module or a go.work names its own file', () => {
    const single = inventoryOf({
      layers: [
        layer('workspaces', 'go.mod', [
          {
            id: 'example.com/a',
            name: 'example.com/a',
            ecosystem: 'Go',
            kind: 'workspace',
            path: 'svc',
          },
        ]),
        layer('packages', 'go mod graph', [pkg('example.com/dep', 'v1.0.0', { ecosystem: 'Go' })]),
      ],
      errors: [],
    })
    expect(single.packages[0]?.source).toBe('svc/go.mod')
    const work = inventoryOf({
      layers: [
        layer('workspaces', 'go.work', []),
        layer('packages', 'go mod graph', [pkg('example.com/dep', 'v1.0.0', { ecosystem: 'Go' })]),
      ],
      errors: [],
    })
    expect(work.packages[0]?.source).toBe('go.work')
  })

  test('reports a failed source or a missing package layer as a problem', () => {
    expect(
      inventoryOf({
        layers: [layer('packages', 'bun.lock', [pkg('some-lib', '1.0.0')])],
        errors: [{ source: 'go', message: 'go mod graph failed' }],
      }).problem,
    ).toBe('go: go mod graph failed')
    expect(
      inventoryOf({ layers: [layer('workspaces', 'package.json', [])], errors: [] }).problem,
    ).toBe('no lockfile the index reads')
  })
})
