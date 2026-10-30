import { expect, test } from 'bun:test'

import type { Repository, TreeEntry } from '@holtkeeper/forge'
import type { Block } from '@holtkeeper/report'

import {
  analyzeStack,
  classifyFile,
  type LifecycleCycle,
  type StackData,
  stackAnalysis,
  type StackForge,
  stackTotals,
  summarizeStack,
  type VersionSources,
} from '../src/index.ts'

function fakeForge(
  files: Record<string, Record<string, string>>,
  archived: string[] = [],
): StackForge {
  return {
    async getRepository(path): Promise<Repository> {
      if (!(path in files)) throw new Error(`404 ${path}`)
      return {
        path,
        name: path,
        defaultBranch: 'main',
        webUrl: `https://git.test/${path}`,
        cloneUrl: `https://git.test/${path}.git`,
        archived: archived.includes(path),
      }
    },
    async readFile(path, file) {
      return files[path]?.[file]
    },
    async listFiles(path): Promise<TreeEntry[]> {
      return Object.keys(files[path] ?? {}).map((file) => ({ path: file, type: 'file' }))
    },
  }
}

const lifecycles: Record<string, LifecycleCycle[]> = {
  nodejs: [
    { cycle: '26', eol: '2029-04-30', latest: '26.1.0' },
    { cycle: '24', eol: '2028-04-30', lts: '2025-10-28', latest: '24.11.0' },
    { cycle: '22', eol: '2027-04-30', lts: '2024-10-29', latest: '22.21.0' },
    { cycle: '18', eol: '2025-04-30', lts: true, latest: '18.20.8' },
  ],
  postgresql: [
    { cycle: '18', eol: '2030-11-14', latest: '18.1' },
    { cycle: '16', eol: '2028-11-09', latest: '16.10' },
    { cycle: '13', eol: '2025-11-13', latest: '13.22' },
  ],
}

function fakeSources(): VersionSources & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async lifecycle(product) {
      calls.push(`eol:${product}`)
      return lifecycles[product]
    },
    async npm(name) {
      calls.push(`npm:${name}`)
      return { pnpm: '10.20.0' }[name]
    },
    async pypi() {
      return undefined
    },
    async imageTags(registry, repository) {
      calls.push(`image:${registry}/${repository}`)
      return repository === 'acme/base' ? ['2.3.0', '2.4.1', '3.0.0-rc.1', 'latest'] : undefined
    },
  }
}

const files = {
  'acme/web': {
    '.nvmrc': '22\n',
    'package.json': JSON.stringify({ packageManager: 'pnpm@9.12.0' }),
    Dockerfile: 'FROM node:22.3-alpine AS build\nFROM ghcr.io/acme/base:2.3.0\n',
    'docker-compose.yml': 'services:\n  db:\n    image: postgres:16.4\n',
  },
  'acme/legacy': {
    '.nvmrc': 'v18.19.0\n',
    'package.json': '{}',
    '.gitlab-ci.yml': 'test:\n  image: node:18\n  services:\n    - postgres:13\n',
    'node_modules/x/Dockerfile': 'FROM busybox\n',
  },
  'acme/tools': {
    'go.mod': 'module example.com/tools\n\ngo 1.23\n',
    'deploy/values.yaml': 'image:\n  repository: ghcr.io/acme/base\n  tag: 2.4.1\n',
  },
  'acme/old': {},
}

const repos = ['acme/web', 'acme/legacy', 'acme/tools', 'acme/old', 'acme/missing'].map((path) => ({
  forge: 'work',
  path,
}))
const now = new Date('2026-10-30T00:00:00Z')

const analyze = () =>
  analyzeStack({
    group: 'acme',
    repos,
    forge: fakeForge(files, ['acme/old']),
    sources: fakeSources(),
    ignore: ['go'],
    now,
  })

test('classifies the files it reads', () => {
  expect(classifyFile('Dockerfile')).toBe('dockerfile')
  expect(classifyFile('services/api/Dockerfile.prod')).toBe('dockerfile')
  expect(classifyFile('docker/app.dockerfile')).toBe('dockerfile')
  expect(classifyFile('compose.override.yaml')).toBe('compose')
  expect(classifyFile('.github/workflows/ci.yml')).toBe('ci')
  expect(classifyFile('.gitlab/ci/build.yml')).toBe('ci')
  expect(classifyFile('charts/api/values.yaml')).toBe('deploy')
  expect(classifyFile('charts/api/templates/deployment.yaml')).toBeUndefined()
  expect(classifyFile('node_modules/x/Dockerfile')).toBeUndefined()
  expect(classifyFile('.devcontainer/Dockerfile')).toBeUndefined()
  expect(classifyFile('src/config.yaml')).toBeUndefined()
})

test('groups version files and images into components with latest versions', async () => {
  const data = await analyze()
  const byId = new Map(data.components.map((component) => [component.id, component]))
  expect([...byId.keys()].toSorted()).toEqual([
    'image:ghcr.io/acme/base',
    'node',
    'pnpm',
    'postgres',
  ])

  const node = byId.get('node')
  expect(node).toMatchObject({
    kind: 'runtime',
    latest: '26.1.0',
    latestLts: '24.11.0',
    source: 'endoflife.date/nodejs',
  })
  expect(node?.usages.map((usage) => [usage.repo, usage.file, usage.version, usage.via])).toEqual([
    ['acme/web', '.nvmrc', '22', 'version-file'],
    ['acme/web', 'Dockerfile', '22.3', 'dockerfile'],
    ['acme/legacy', '.nvmrc', '18.19.0', 'version-file'],
    ['acme/legacy', '.gitlab-ci.yml', '18', 'ci'],
  ])
  expect(byId.get('image:ghcr.io/acme/base')).toMatchObject({ kind: 'image', latest: '2.4.1' })
  expect(byId.get('pnpm')).toMatchObject({ kind: 'package-manager', latest: '10.20.0' })

  expect(data.repos.find((repo) => repo.path === 'acme/old')?.archived).toBe(true)
  expect(data.repos.find((repo) => repo.path === 'acme/missing')?.error).toContain('404')
  expect(data.repos.find((repo) => repo.path === 'acme/tools')?.files).toEqual([
    'go.mod',
    'deploy/values.yaml',
  ])
})

test('summarizes end of life, lag and spread per repository', async () => {
  const data = await analyze()
  const summaries = summarizeStack(data)
  const node = summaries.find((summary) => summary.component.id === 'node')
  expect(node?.eolRepos).toEqual(['acme/legacy'])
  expect(node?.behindMajorRepos).toEqual(['acme/legacy', 'acme/web'])
  expect(node?.majors).toEqual(['18', '22'])
  expect(node?.cells.get('acme/web')?.usage.version).toBe('22.3')
  expect(node?.cycles.map((entry) => [entry.cycle.cycle, entry.support, entry.repos])).toEqual([
    ['18', 'eol', ['acme/legacy']],
    ['22', 'lts', ['acme/web']],
  ])
  expect(stackTotals(data)).toEqual({
    repos: 3,
    components: 4,
    reposOnEol: 1,
    reposEolSoon: 0,
    reposBehindMajor: 2,
    multiMajor: 2,
    floating: 0,
  })
})

const record = (data: StackData, createdAt: string) => ({
  id: createdAt,
  repo: { forge: 'work', path: 'acme' },
  kind: 'stack',
  createdAt,
  data,
})

const blocksOf = (report: ReturnType<typeof stackAnalysis.toReport>, id: string): Block[] =>
  report.sections.find((section) => section.id === id)?.blocks ?? []

test('reports end of life with new and resolved lines against the previous record', async () => {
  const data = await analyze()
  expect(stackAnalysis.schema.parse(data)).toEqual(data)
  const previous: StackData = {
    ...data,
    components: data.components.map((component) =>
      component.id === 'postgres'
        ? { ...component, usages: component.usages.filter((usage) => usage.version !== '13') }
        : component.id === 'node'
          ? {
              ...component,
              usages: [
                ...component.usages,
                {
                  repo: 'acme/tools',
                  file: '.nvmrc',
                  via: 'version-file',
                  declared: '18',
                  version: '18',
                },
              ],
            }
          : component,
    ),
  }
  const report = stackAnalysis.toReport(
    record(data, '2026-10-30T00:00:00Z'),
    record(previous, '2026-10-23T00:00:00Z'),
  )
  expect(report.metrics.find((entry) => entry.id === 'eol')).toMatchObject({
    value: 1,
    tone: 'bad',
  })
  const issues = blocksOf(report, 'lifecycle').find((block) => block.type === 'issues')
  expect(issues?.type === 'issues' && issues.items.map((item) => [item.title, item.tags])).toEqual([
    ['Node.js 18 reached end of life on 2025-04-30', ['Runtimes']],
    ['PostgreSQL 13 reached end of life on 2025-11-13', ['Services', 'new']],
  ])
  const timeline = blocksOf(report, 'lifecycle').find((block) => block.type === 'timeline')
  expect(timeline?.type === 'timeline' && timeline.items[0]?.title).toBe('Node.js 18')

  const matrix = blocksOf(report, 'versions').find((block) => block.type === 'table')
  const column =
    matrix?.type === 'table' ? matrix.columns.find((entry) => entry.label === 'Node.js') : undefined
  const legacy =
    matrix?.type === 'table' ? matrix.rows.find((row) => row.repo === 'acme/legacy') : undefined
  expect(legacy?.[column?.key ?? '']).toMatchObject({ text: '18.19.0 (+1)', tone: 'bad' })

  const graph = blocksOf(report, 'map').find((block) => block.type === 'graph')
  expect(graph?.type === 'graph' && graph.nodes.some((node) => node.id === 'line:node@22')).toBe(
    true,
  )
  expect(report.sections.map((section) => section.id)).toEqual([
    'lifecycle',
    'versions',
    'components',
    'map',
    'usages',
    'notes',
  ])
})

test('skips lookups without sources', async () => {
  const data = await analyzeStack({
    group: 'acme',
    repos: repos.slice(0, 1),
    forge: fakeForge(files),
    now,
  })
  expect(data.components.every((component) => component.latest === undefined)).toBe(true)
  expect(data.notes).toEqual([])
})
