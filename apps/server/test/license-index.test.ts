import { expect, test } from 'bun:test'

import { parseConfig } from '@holtkeeper/core'
import { type DepNode, analyzeLayer } from '@holtkeeper/depgraph'
import type { RepoRef } from '@holtkeeper/forge'
import { type DepsDevClient, type LicensesData, INDEX_TOOL } from '@holtkeeper/licenses'
import { memoryStore } from '@holtkeeper/store/memory'

import { LICENSE_INDEX_ACTOR, runLicenseIndex } from '../src/license-index.ts'

const forge = { kind: 'gitlab', url: 'https://gitlab.test', create: () => ({}) as never }
const config = parseConfig({
  forges: { work: forge },
  teams: { games: { owns: ['work:games/*'] } },
})

const alpha: RepoRef = { forge: 'work', path: 'games/alpha' }
const beta: RepoRef = { forge: 'work', path: 'games/beta' }
const gamma: RepoRef = { forge: 'work', path: 'games/gamma' }

const pkg = (name: string, version: string): DepNode => ({
  id: `${name}@${version}`,
  name,
  version,
  ecosystem: 'npm',
  kind: 'package',
})

const graph = (nodes: DepNode[], errors: { source: string; message: string }[] = []) => ({
  layers: [analyzeLayer({ id: 'packages', source: 'bun.lock', graph: { nodes, edges: [] } })],
  errors,
})

const workspace = (name: string, version: string) => ({
  layers: [
    analyzeLayer({
      id: 'packages',
      source: 'bun.lock',
      graph: {
        nodes: [{ id: name, name, version, ecosystem: 'npm', kind: 'workspace' }],
        edges: [],
      },
    }),
  ],
  errors: [],
})

function fakeDepsDev(licenses: Record<string, string[]>) {
  const asked: string[] = []
  let failing = false
  const client: DepsDevClient = {
    async licenses(version) {
      if (failing) throw new Error('deps.dev is down')
      asked.push(`${version.name}@${version.version}`)
      return licenses[`${version.name}@${version.version}`] ?? []
    },
  }
  return {
    client,
    asked,
    fail: () => {
      failing = true
    },
  }
}

async function setup() {
  const store = memoryStore()
  let clock = new Date('2026-11-18T10:00:00.000Z')
  const deps = { config, store, now: () => clock }
  const addGraph = (repo: RepoRef, data: unknown, at: string) =>
    store.analyses.add({ repo, kind: 'depgraph', createdAt: at, sha: 'abc123', data })
  await addGraph(
    alpha,
    graph([pkg('some-lib', '1.0.0'), pkg('copyleft-lib', '2.0.0'), pkg('@acme/kit', '1.0.0')]),
    '2026-11-18T09:00:00.000Z',
  )
  await addGraph(beta, workspace('@acme/kit', '1.0.0'), '2026-11-18T09:00:00.000Z')
  await addGraph(
    gamma,
    graph([pkg('some-lib', '1.0.0')], [{ source: 'go', message: 'go mod graph failed' }]),
    '2026-11-18T09:00:00.000Z',
  )
  const depsDev = fakeDepsDev({ 'some-lib@1.0.0': ['MIT'], 'copyleft-lib@2.0.0': ['GPL-3.0-only'] })
  const listed: string[] = []
  const options = {
    client: depsDev.client,
    rootFiles: async (repo: RepoRef) => {
      listed.push(repo.path)
      return ['LICENSE.md', 'package.json', 'README.md']
    },
  }
  return {
    store,
    deps,
    depsDev,
    listed,
    options,
    addGraph,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms)
    },
    latest: async (repo: RepoRef) =>
      (await store.analyses.latest({ repo, kind: 'licenses' }))[0] as
        | { data: LicensesData; actor?: string; sha?: string }
        | undefined,
  }
}

test('judges every repository from its graph, looking each version up once', async () => {
  const { deps, depsDev, listed, options, latest } = await setup()
  const summary = await runLicenseIndex(deps, options)
  expect(summary).toMatchObject({ full: true, repos: 2, packages: 2, fetched: 2, written: 2 })
  expect(summary?.skipped).toEqual([
    { repo: 'work:games/gamma', reason: 'go: go mod graph failed' },
  ])
  expect(depsDev.asked.toSorted()).toEqual(['copyleft-lib@2.0.0', 'some-lib@1.0.0'])
  expect(listed.toSorted()).toEqual(['games/alpha', 'games/beta'])

  const record = await latest(alpha)
  expect(record?.actor).toBe(LICENSE_INDEX_ACTOR)
  expect(record?.sha).toBe('abc123')
  expect(record?.data.tool).toEqual({ name: INDEX_TOOL })
  expect(record?.data.project).toEqual({ licenseFiles: ['LICENSE.md'] })
  expect(
    Object.fromEntries(record?.data.packages.map((each) => [each.name, each.verdict]) ?? []),
  ).toEqual({ '@acme/kit': 'internal', 'copyleft-lib': 'denied', 'some-lib': 'allowed' })
  expect(await latest(gamma)).toBeUndefined()
})

test('writes only what changed, re-judges on a full run and keeps two records', async () => {
  const { store, deps, depsDev, listed, options, advance, addGraph, latest } = await setup()
  await runLicenseIndex(deps, options)

  advance(60_000)
  expect(await runLicenseIndex(deps, options)).toMatchObject({ full: false, repos: 0, written: 0 })

  await addGraph(alpha, graph([pkg('some-lib', '1.0.0')]), '2026-11-18T10:00:30.000Z')
  advance(60_000)
  expect(await runLicenseIndex(deps, options)).toMatchObject({
    full: false,
    repos: 1,
    fetched: 0,
    written: 1,
  })
  expect(depsDev.asked).toHaveLength(2)
  expect(listed.filter((path) => path === 'games/alpha')).toHaveLength(2)
  expect((await latest(alpha))?.data.packages.map((each) => each.name)).toEqual(['some-lib'])

  await store.settings.put({
    id: 'deny-mit',
    key: 'analyzers.licenses',
    scope: { all: true },
    value: { deny: ['MIT'] },
    secret: false,
    updatedAt: '2026-11-18T10:03:00.000Z',
  })
  advance(3_600_000)
  expect(await runLicenseIndex(deps, options)).toMatchObject({ full: true, written: 2 })
  expect((await latest(alpha))?.data.packages[0]?.verdict).toBe('denied')
  expect(listed.filter((path) => path === 'games/alpha')).toHaveLength(2)
  expect(await store.analyses.list({ repo: alpha, kind: 'licenses' })).toHaveLength(2)
})

test('a failed lookup writes nothing', async () => {
  const { deps, depsDev, options, latest } = await setup()
  depsDev.fail()
  const failure: unknown = await runLicenseIndex(deps, options).catch((caught: unknown) => caught)
  expect(String(failure)).toContain('deps.dev is down')
  expect(await latest(alpha)).toBeUndefined()
})
