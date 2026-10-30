import { describe, expect, test } from 'bun:test'

import type { AnalysisRecord } from '@holtkeeper/store'

import type { DepgraphData } from './analyze.ts'
import { latestDepgraphs, loadPackageCatalog, packageCatalog } from './catalog.ts'
import type { DepGraph } from './model.ts'
import { graphStats } from './stats.ts'

const defining = (...workspaces: [string, string | undefined][]): DepgraphData => {
  const graph: DepGraph = {
    nodes: workspaces.map(([name, version]) => ({
      id: name,
      name,
      ...(version ? { version } : {}),
      ecosystem: 'npm',
      kind: 'workspace' as const,
      path: `packages/${name.split('/').at(-1)}`,
    })),
    edges: [],
  }
  return {
    layers: [
      {
        id: 'workspaces',
        source: 'test',
        graph,
        cycles: [],
        duplicates: [],
        stats: graphStats(graph),
      },
    ],
    errors: [],
  }
}

const record = (path: string, createdAt: string, data: unknown): AnalysisRecord => ({
  id: `${path}@${createdAt}`,
  kind: 'depgraph',
  repo: { forge: 'work', path },
  createdAt,
  data,
})

describe('packageCatalog', () => {
  test('finds versioned workspaces of every repository, the highest version winning', () => {
    const catalog = packageCatalog([
      {
        repo: { forge: 'work', path: 'libs/a' },
        data: defining(['@co/ui', '1.2.0'], ['app', undefined]),
      },
      { repo: { forge: 'work', path: 'libs/b' }, data: defining(['@co/ui', '1.10.0']) },
    ])
    expect(catalog.find('npm', '@co/ui')).toEqual({
      ecosystem: 'npm',
      name: '@co/ui',
      version: '1.10.0',
      path: 'packages/ui',
      repo: { forge: 'work', path: 'libs/b' },
    })
    expect(catalog.find('npm', 'app')).toBeUndefined()
    expect(catalog.find('Go', '@co/ui')).toBeUndefined()
    expect(catalog.size).toBe(1)
  })
})

describe('loadPackageCatalog', () => {
  test('reads the newest valid depgraph record per repository', async () => {
    const records = [
      record('libs/a', '2026-10-30T02:00:00Z', defining(['@co/ui', '2.0.0'])),
      record('libs/a', '2026-10-30T01:00:00Z', defining(['@co/old', '1.0.0'])),
      record('libs/b', '2026-10-30T00:00:00Z', { not: 'a graph' }),
    ]
    const analyses = { list: async () => records }
    const catalog = await loadPackageCatalog(analyses)
    expect(catalog.find('npm', '@co/ui')?.version).toBe('2.0.0')
    expect(catalog.find('npm', '@co/old')).toBeUndefined()
    const latest = await latestDepgraphs(analyses, { accept: (r) => r.repo.path !== 'libs/a' })
    expect([...latest.keys()]).toEqual([])
  })
})
