import { expect, test } from 'bun:test'

import type { Block } from '@holtkeeper/report'

import { analyzeFleet } from '../src/analyze.ts'
import { summarizeLibrary } from '../src/matrix.ts'
import { fleetAnalysis } from '../src/report.ts'
import type { FleetData } from '../src/types.ts'
import { fakeForge, fakeRegistry } from './fakes.ts'
import { fleetFiles, latestVersions } from './fleet.ts'

const repos = ['acme/web', 'acme/admin', 'acme/shop', 'acme/api'].map((path) => ({
  forge: 'work',
  path,
}))

const analyze = (files: Record<string, Record<string, string>>) =>
  analyzeFleet({
    group: 'acme',
    forgeId: 'work',
    repos,
    forge: fakeForge(files),
    registry: fakeRegistry(latestVersions),
    libraries: ['@acme/*', 'github.com/acme/**'],
    templates: [{ path: '.nvmrc', mode: 'exact', create: true, source: { content: '22\n' } }],
  })

const record = (data: FleetData, createdAt: string) => ({
  id: createdAt,
  repo: { forge: 'work', path: 'acme' },
  kind: 'fleet',
  createdAt,
  data,
})

const blocksOf = (report: ReturnType<typeof fleetAnalysis.toReport>, id: string): Block[] =>
  report.sections.find((section) => section.id === id)?.blocks ?? []

test('summarizes spread, oldest major and lag per library', async () => {
  const data = await analyze(fleetFiles)
  const react = summarizeLibrary(data.libraries.find((library) => library.name === 'react')!)
  expect(react.versions).toEqual(['17.0.2', '18.3.1', '19.1.0'])
  expect(react.majors).toEqual([17, 18, 19])
  expect(react.reposOnOldest).toEqual(['acme/admin'])
  expect(react.reposBehindMajor).toEqual(['acme/admin', 'acme/web'])
  expect(react.cells.get('acme/web')).toMatchObject({
    version: '18.3.1',
    lag: 'major',
    versions: ['18.3.1', '19.1.0'],
  })
})

test('report compares with the previous record', async () => {
  const before = await analyze(fleetFiles)
  const after = await analyze({
    ...fleetFiles,
    'acme/admin': {
      ...fleetFiles['acme/admin'],
      '.nvmrc': '22\n',
      'package-lock.json': JSON.stringify({
        lockfileVersion: 3,
        packages: {
          'node_modules/react': { version: '19.1.0' },
          'node_modules/@acme/ui': { version: '3.2.0' },
          'node_modules/typescript': { version: '5.7.2' },
        },
      }),
    },
  })
  const report = fleetAnalysis.toReport(
    record(after, '2026-10-30T00:00:00.000Z'),
    record(before, '2026-10-01T00:00:00.000Z'),
  )
  expect(report.subject?.compareTo).toBe('2026-10-01')
  const metrics = Object.fromEntries(
    report.metrics.map((entry) => [entry.id, [entry.value, entry.delta]]),
  )
  expect(metrics).toEqual({
    repos: [4, 0],
    libraries: [4, 0],
    'multi-major': [1, -1],
    'behind-major': [2, -1],
    drifted: [0, -1],
    missing: [1, 0],
  })
  expect(report.sections.map((section) => section.id)).toEqual(['versions', 'libraries', 'config'])

  const [matrix, chart] = blocksOf(report, 'versions')
  expect(
    matrix?.type === 'table' && matrix.rows.find((row) => row['repo'] === 'acme/api'),
  ).toMatchObject({
    l1: { text: 'v1.4.0', tone: 'bad' },
  })
  expect(
    chart?.type === 'chart' && chart.data.find((datum) => datum['library'] === 'react'),
  ).toEqual({
    library: 'react',
    current: 2,
    minor: 0,
    major1: 1,
    major2: 0,
    unknown: 0,
  })

  const libraries = blocksOf(report, 'libraries')
  expect(libraries[1]?.type === 'issues' && libraries[1].items.map((item) => item.title)).toEqual([
    '@acme/ui is down to one major',
  ])

  const config = blocksOf(report, 'config')
  const issues = config.find((block) => block.type === 'issues')
  expect(issues?.type === 'issues' && issues.items.map((item) => [item.title, item.tags])).toEqual([
    ['acme/shop: .nvmrc missing', ['exact']],
    ['acme/admin: .nvmrc matches the template again', ['exact', 'resolved']],
  ])
  const changes = config.find((block) => block.type === 'changes')
  expect(changes?.type === 'changes' && changes.applicable).toBe(true)
  expect(changes?.type === 'changes' && changes.items[0]?.diff[0]?.status).toBe('added')
  expect(fleetAnalysis.changes?.(after).map((change) => change.target?.path)).toEqual(['acme/shop'])
})

test('notes unreadable repositories and unknown latest versions', async () => {
  const data = await analyzeFleet({
    group: 'acme',
    forgeId: 'work',
    repos: [...repos, { forge: 'work', path: 'acme/gone' }],
    forge: fakeForge(fleetFiles),
    registry: fakeRegistry({}),
    minRepos: 3,
  })
  const report = fleetAnalysis.toReport(record(data, '2026-10-30T00:00:00.000Z'))
  expect(report.metrics.every((entry) => entry.delta === undefined)).toBe(true)
  const notes = blocksOf(report, 'notes')[0]
  expect(notes?.type === 'issues' && notes.items.map((item) => item.title)).toEqual([
    'acme/gone could not be read',
    'Latest version of react is unknown',
    'Latest version of typescript is unknown',
  ])
  expect(blocksOf(report, 'config')).toEqual([
    { type: 'markdown', text: 'No templates are configured.' },
  ])
  expect(fleetAnalysis.summarize(data).find((entry) => entry.id === 'repos')?.value).toBe(4)
})
