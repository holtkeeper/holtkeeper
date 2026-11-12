import { beforeEach, describe, expect, test } from 'bun:test'

import type { AnalysisSummary } from '@holtkeeper/api'
import { noAuth } from '@holtkeeper/auth-none'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { defineAnalysis } from '@holtkeeper/report'
import type { AnalysisStore, Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'
import { z } from 'zod'

import { latestHeadsWithMetrics, summarizeAnalysis } from '../src/analyses.ts'
import { createApp } from '../src/app.ts'

interface WidgetMetrics {
  count: number
  limit?: number
  delta?: number
}

const limitOf = (options: unknown) => z.object({ limit: z.number() }).safeParse(options).data?.limit

const widgets = defineAnalysis<{ count: number }, WidgetMetrics>({
  kind: 'widgets',
  label: 'Widgets',
  schema: z.object({ count: z.number() }),
  summarize: (data) => [{ id: 'count', label: 'Count', value: data.count.valueOf() }],
  toReport: () => {
    throw new Error('not used')
  },
  metrics: (data, { options, previous }) => {
    const limit = limitOf(options)
    return {
      count: data.count,
      ...(limit === undefined ? {} : { limit }),
      ...(previous ? { delta: data.count - previous.count } : {}),
    }
  },
})

const gadgets = defineAnalysis<{ size: number }>({
  kind: 'gadgets',
  label: 'Gadgets',
  schema: z.object({ size: z.number() }),
  summarize: () => [],
  toReport: () => {
    throw new Error('not used')
  },
})

const kinds = new Map<string, typeof widgets | typeof gadgets>([
  ['widgets', widgets],
  ['gadgets', gadgets],
])

const record = (kind: string, data: unknown) => ({
  id: 'r1',
  repo: { forge: 'work', path: 'shapes/a' },
  kind,
  createdAt: '2026-11-01T00:00:00.000Z',
  data,
})

let store: Store

beforeEach(() => {
  store = memoryStore()
})

const add = (
  path: string,
  kind: string,
  day: string,
  data: unknown,
  metrics?: object,
  ref?: string,
) =>
  store.analyses.add({
    repo: { forge: 'work', path },
    kind,
    createdAt: `2026-11-${day}T00:00:00.000Z`,
    data,
    ...(metrics ? { metrics } : {}),
    ...(ref ? { ref } : {}),
  })

const counting = (analyses: AnalysisStore) => {
  const reads = { latest: [] as (string | undefined)[], get: 0 }
  return {
    reads,
    analyses: {
      latestHeads: (query?: Parameters<AnalysisStore['latestHeads']>[0]) =>
        analyses.latestHeads(query),
      heads: (query?: Parameters<AnalysisStore['heads']>[0]) => analyses.heads(query),
      get: async (id: string) => {
        reads.get++
        return analyses.get(id)
      },
      latest: async (query?: Parameters<AnalysisStore['latest']>[0]) => {
        reads.latest.push(query?.kind)
        return analyses.latest(query)
      },
    },
  }
}

const setup = () => {
  const vault = aesVault('v'.repeat(32))
  return createApp({
    config: parseConfig({ forges: {}, groups: {} }),
    auth: noAuth(),
    store,
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: [],
    analyses: [widgets],
    now: () => new Date('2026-11-10T12:00:00.000Z'),
  })
}

const ingest = async (count: unknown, createdAt: string) =>
  (await (
    await setup().request('/api/analyses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repo: { forge: 'work', path: 'shapes/a' },
        kind: 'widgets',
        createdAt,
        data: { count },
      }),
    })
  ).json()) as AnalysisSummary

test('records of unknown kinds or an older data shape list without metrics', () => {
  const known = new Map([['widgets', widgets]])
  expect(summarizeAnalysis(known, record('widgets', { count: 2 })).metrics).toEqual([
    { id: 'count', label: 'Count', value: 2 },
  ])
  expect(summarizeAnalysis(known, record('widgets', {}))).toMatchObject({
    label: 'Widgets',
    metrics: [],
  })
  expect(summarizeAnalysis(known, record('retired', { count: 1 }))).toMatchObject({
    label: 'retired',
    metrics: [],
  })
})

describe('latestHeadsWithMetrics', () => {
  test('computes metrics once for the newest records stored without them', async () => {
    await add('shapes/a', 'widgets', '01', { count: 1 })
    const old = await add('shapes/a', 'widgets', '02', { count: 4 })
    const stored = await add('shapes/b', 'widgets', '03', { count: 9 }, { count: 9, limit: 3 })
    const unreadable = await add('shapes/c', 'widgets', '04', { count: 'many' })
    const plain = await add('shapes/a', 'gadgets', '05', { size: 1 })
    const retired = await add('shapes/a', 'retired', '06', { count: 1 })
    const { analyses, reads } = counting(store.analyses)

    const heads = await latestHeadsWithMetrics(analyses, kinds)
    expect(reads.latest).toEqual(['widgets'])
    expect(Object.fromEntries(heads.map((head) => [head.id, head.metrics]))).toEqual({
      [old.id]: { count: 4 },
      [stored.id]: { count: 9, limit: 3 },
      [unreadable.id]: undefined,
      [plain.id]: undefined,
      [retired.id]: undefined,
    })
    expect(heads.every((head) => !('data' in head))).toBe(true)
    expect((await store.analyses.get(old.id))?.metrics).toBeUndefined()
    expect(
      (await store.analyses.heads({ repo: { forge: 'work', path: 'shapes/a' } })).map(
        (head) => head.metrics,
      ),
    ).toEqual([undefined, undefined, undefined, undefined])

    const again = await latestHeadsWithMetrics(analyses, kinds)
    expect(reads.latest).toEqual(['widgets'])
    expect(again.find((head) => head.id === old.id)?.metrics).toEqual({ count: 4 })
  })

  test('reads no data when every newest record has metrics or its kind has none', async () => {
    await add('shapes/a', 'widgets', '01', { count: 1 }, { count: 1 })
    await add('shapes/a', 'gadgets', '02', { size: 1 })
    const { analyses, reads } = counting(store.analyses)
    const heads = await latestHeadsWithMetrics(analyses, kinds, {
      repo: { forge: 'work', path: 'shapes/a' },
    })
    expect(reads.latest).toEqual([])
    expect(heads.map((head) => head.metrics)).toEqual([undefined, { count: 1 }])
  })

  test('a newer run on another branch does not replace the default branch head', async () => {
    const main = await add('shapes/a', 'widgets', '01', { count: 2 })
    await add('shapes/a', 'widgets', '02', { count: 50 }, { count: 50 }, 'feature')
    const branchOnly = await add('shapes/b', 'widgets', '03', { count: 7 }, { count: 7 }, 'wip')
    const { analyses, reads } = counting(store.analyses)
    const heads = await latestHeadsWithMetrics(analyses, kinds)
    expect(Object.fromEntries(heads.map((head) => [head.id, head.metrics]))).toEqual({
      [main.id]: { count: 2 },
      [branchOnly.id]: { count: 7 },
    })
    expect(reads).toEqual({ latest: [], get: 1 })
  })
})

test('ingest stores metrics with the scoped analyzer options and the previous record', async () => {
  await store.settings.put({
    id: 's1',
    key: 'analyzers.widgets',
    scope: { all: true },
    value: { limit: 5 },
    secret: false,
    updatedAt: '2026-11-01T00:00:00.000Z',
  })
  const first = await ingest(2, '2026-11-01T00:00:00.000Z')
  const second = await ingest(6, '2026-11-02T00:00:00.000Z')
  expect((await store.analyses.get(first.id))?.metrics).toEqual({ count: 2, limit: 5 })
  expect((await store.analyses.get(second.id))?.metrics).toEqual({ count: 6, limit: 5, delta: 4 })
})
