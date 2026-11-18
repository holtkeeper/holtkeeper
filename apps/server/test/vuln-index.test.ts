import { describe, expect, test } from 'bun:test'

import { auditAnalyzer } from '@holtkeeper/analyzers'
import { parseConfig } from '@holtkeeper/core'
import { type DepNode, analyzeLayer } from '@holtkeeper/depgraph'
import type { RepoRef } from '@holtkeeper/forge'
import { memoryStore } from '@holtkeeper/store/memory'
import type { OsvClient, OsvPackageQuery, OsvRecord } from '@holtkeeper/vuln-osv'

import { VULN_INDEX_ACTOR, runVulnIndex } from '../src/vuln-index.ts'

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

const range = (name: string, fixed?: string) => [
  {
    package: { name, ecosystem: 'npm' },
    ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, ...(fixed ? [{ fixed }] : [])] }],
  },
]

function fakeOsv(initial: Record<string, OsvRecord[]>) {
  let advisories = initial
  const queried: OsvPackageQuery[] = []
  const client: OsvClient = {
    async queryBatch(queries) {
      queried.push(...queries)
      return queries.map((query) =>
        (advisories[`${query.name}@${query.version}`] ?? []).map((record) => ({
          id: record.id,
          modified: record.modified ?? '2026-01-01T00:00:00Z',
        })),
      )
    },
    async vulnerability(id) {
      return Object.values(advisories)
        .flat()
        .find((record) => record.id === id)
    },
  }
  return {
    client,
    queried,
    set: (next: Record<string, OsvRecord[]>) => {
      advisories = next
    },
  }
}

async function setup() {
  const store = memoryStore()
  let clock = new Date('2026-11-18T10:00:00.000Z')
  const deps = { config, store, analyzers: [auditAnalyzer], now: () => clock }
  const addGraph = (repo: RepoRef, data: unknown, at: string) =>
    store.analyses.add({ repo, kind: 'depgraph', createdAt: at, sha: 'abc123', data })
  await addGraph(
    alpha,
    graph([pkg('some-lib', '1.0.0'), pkg('other-lib', '2.0.0'), pkg('@acme/kit', '1.0.0')]),
    '2026-11-18T09:00:00.000Z',
  )
  await addGraph(
    beta,
    {
      layers: [
        analyzeLayer({
          id: 'packages',
          source: 'bun.lock',
          graph: {
            nodes: [
              {
                id: '@acme/kit',
                name: '@acme/kit',
                version: '1.0.0',
                ecosystem: 'npm',
                kind: 'workspace',
              },
            ],
            edges: [],
          },
        }),
      ],
      errors: [],
    },
    '2026-11-18T09:00:00.000Z',
  )
  await addGraph(
    gamma,
    graph([pkg('some-lib', '1.0.0')], [{ source: 'go', message: 'go mod graph failed' }]),
    '2026-11-18T09:00:00.000Z',
  )
  await store.settings.put({
    id: 'fix',
    key: 'audit.fix',
    scope: { all: true },
    value: true,
    secret: false,
    updatedAt: '2026-11-01T00:00:00.000Z',
  })
  const osv = fakeOsv({
    'some-lib@1.0.0': [
      { id: 'GHSA-aaaa-bbbb-cccc', summary: 'fixable', affected: range('some-lib', '1.0.1') },
    ],
    '@acme/kit@1.0.0': [{ id: 'GHSA-name-clash-0000', affected: range('@acme/kit', '9.9.9') }],
  })
  const run = (full?: boolean) =>
    runVulnIndex(deps, { client: osv.client, ...(full !== undefined && { full }) })
  const tick = (ms: number) => {
    clock = new Date(clock.getTime() + ms)
  }
  return { store, osv, run, tick, addGraph }
}

describe('runVulnIndex', () => {
  test('stores state Postgres jsonb accepts (no NUL characters)', async () => {
    const { store, run } = await setup()
    await run()
    const state = JSON.stringify(await store.kv?.get('vuln-index:state'))
    expect(state).toContain('npm:@acme/kit')
    expect(state).not.toContain(String.raw`\u0000`)
  })

  test('writes audit records from the dependency graphs and queues a fix run', async () => {
    const { store, osv, run } = await setup()
    const summary = await run()
    expect(summary).toMatchObject({ full: true, repos: 2, written: 2, queued: 1 })
    expect(summary?.skipped).toEqual([
      { repo: 'work:games/gamma', reason: 'go: go mod graph failed' },
    ])
    expect(osv.queried.map((query) => query.name).toSorted()).toEqual(['other-lib', 'some-lib'])

    const [record] = await store.analyses.latest({ repo: alpha, kind: 'audit' })
    expect(record).toMatchObject({ actor: VULN_INDEX_ACTOR, sha: 'abc123' })
    expect(record?.data).toMatchObject({
      scanner: 'osv-index',
      findings: [{ id: 'GHSA-aaaa-bbbb-cccc', source: 'bun.lock', fixedVersions: ['1.0.1'] }],
    })
    expect(record?.metrics).toMatchObject({ findings: 1, severities: { unknown: 1 } })
    expect(await store.analyses.latest({ repo: gamma, kind: 'audit' })).toEqual([])
    expect((await store.analyses.list({ kind: 'audit' })).map((each) => each.actor)).toEqual([
      VULN_INDEX_ACTOR,
      VULN_INDEX_ACTOR,
    ])

    const jobs = await store.jobs.list({ analyzer: 'audit' })
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({
      repo: alpha,
      trigger: 'vuln-index',
      reason: 'fixable advisories: GHSA-aaaa-bbbb-cccc',
    })
  })

  test('between full runs only repositories with a new graph are matched', async () => {
    const { osv, run, tick, addGraph } = await setup()
    await run()
    osv.queried.length = 0
    tick(60_000)
    expect(await run()).toMatchObject({ full: false, repos: 0 })
    expect(osv.queried).toEqual([])

    await addGraph(alpha, graph([pkg('some-lib', '1.0.1')]), '2026-11-18T10:00:30.000Z')
    expect(await run()).toMatchObject({ full: false, repos: 1, written: 1, queued: 0 })
    expect(osv.queried.map((query) => `${query.name}@${query.version}`)).toEqual(['some-lib@1.0.1'])
  })

  test('keeps an unchanged audit, rewrites it after a day and queues fixes only for new advisories', async () => {
    const { store, osv, run, tick } = await setup()
    await run()
    const [first] = await store.jobs.list({ analyzer: 'audit' })
    await store.jobs.cancel(first!.id, '2026-11-18T10:00:01.000Z')

    tick(3_600_000)
    expect(await run()).toMatchObject({ full: true, written: 0, queued: 0 })

    osv.set({
      'some-lib@1.0.0': [
        { id: 'GHSA-aaaa-bbbb-cccc', summary: 'fixable', affected: range('some-lib', '1.0.1') },
      ],
      'other-lib@2.0.0': [
        { id: 'GHSA-dddd-eeee-ffff', summary: 'new', affected: range('other-lib', '2.0.5') },
      ],
    })
    tick(3_600_000)
    expect(await run()).toMatchObject({ written: 1, queued: 1 })
    expect(await store.analyses.list({ repo: alpha, kind: 'audit' })).toHaveLength(2)

    tick(86_400_000)
    expect(await run()).toMatchObject({ written: 2, queued: 0 })
    expect(await store.analyses.list({ repo: alpha, kind: 'audit' })).toHaveLength(3)
  })

  test('an OSV failure throws and leaves the state for the next run', async () => {
    const { store, osv, run } = await setup()
    const failing = {
      ...osv.client,
      queryBatch: async () => Promise.reject(new Error('OSV is down')),
    }
    const failure = await runVulnIndex(
      {
        config,
        store,
        analyzers: [auditAnalyzer],
        now: () => new Date('2026-11-18T10:00:00.000Z'),
      },
      { client: failing },
    ).then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
    expect(failure).toBe('OSV is down')
    expect(await store.analyses.latest({ kind: 'audit' })).toEqual([])
    expect(await run()).toMatchObject({ full: true, written: 2 })
  })
})
