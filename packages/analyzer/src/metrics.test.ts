import { describe, expect, test } from 'bun:test'

import { defineAnalysis } from '@holtkeeper/report'
import { memoryStore } from '@holtkeeper/store/memory'
import { z } from 'zod'

import { analysisMetrics, metricsOf, recordMetrics } from './metrics.ts'

const widgets = defineAnalysis<{ count: number }, { count: number; delta?: number; at?: number }>({
  kind: 'widgets',
  label: 'Widgets',
  schema: z.object({ count: z.number() }),
  summarize: () => [],
  toReport: () => {
    throw new Error('not used')
  },
  metrics: (data, { previous }) => {
    if (data.count < 0) throw new Error('negative')
    return {
      count: data.count,
      at: undefined,
      ...(previous ? { delta: data.count - previous.count } : {}),
    }
  },
})

const repo = { forge: 'work', path: 'shapes/a' }

describe('analysisMetrics', () => {
  test('plain JSON of valid data; undefined for unknown kinds, bad data or a throwing kind', () => {
    const metrics = analysisMetrics(widgets, { count: 2 })
    expect(metrics).toEqual({ count: 2 })
    expect(metrics).not.toHaveProperty('at')
    expect(analysisMetrics(undefined, { count: 2 })).toBeUndefined()
    expect(analysisMetrics({ ...widgets, metrics: undefined }, { count: 2 })).toBeUndefined()
    expect(analysisMetrics(widgets, { count: 'two' })).toBeUndefined()
    expect(analysisMetrics(widgets, { count: -1 })).toBeUndefined()
  })
})

describe('recordMetrics', () => {
  test('uses the previous record of the same line, computing its metrics when it has none', async () => {
    const { analyses } = memoryStore()
    await analyses.add({
      repo,
      kind: 'widgets',
      createdAt: '2026-11-01T00:00:00Z',
      data: { count: 1 },
    })
    await analyses.add({
      repo,
      kind: 'widgets',
      ref: 'feature',
      createdAt: '2026-11-02T00:00:00Z',
      data: { count: 50 },
      metrics: { count: 50 },
    })
    expect(
      await recordMetrics(analyses, widgets, {
        repo,
        createdAt: '2026-11-03T00:00:00Z',
        data: { count: 4 },
      }),
    ).toEqual({ count: 4, delta: 3 })
    expect(
      await recordMetrics(analyses, widgets, {
        repo,
        ref: 'feature',
        createdAt: '2026-11-03T00:00:00Z',
        data: { count: 4 },
      }),
    ).toEqual({ count: 4, delta: -46 })
    expect(
      await recordMetrics(analyses, widgets, {
        repo,
        ref: 'v2',
        createdAt: '2026-11-03T00:00:00Z',
        data: { count: 4 },
      }),
    ).toEqual({ count: 4, delta: 3 })
    expect(
      await recordMetrics(analyses, widgets, {
        repo,
        createdAt: '2026-10-01T00:00:00Z',
        data: { count: 4 },
      }),
    ).toEqual({ count: 4 })
    expect(await recordMetrics(analyses, undefined, { repo, data: { count: 4 } })).toBeUndefined()
  })
})

test('metricsOf reads stored metrics of its own kind only', () => {
  expect(metricsOf(widgets, { kind: 'widgets', metrics: { count: 3 } })?.count).toBe(3)
  expect(metricsOf(widgets, { kind: 'gadgets', metrics: { count: 3 } })).toBeUndefined()
  expect(metricsOf(widgets, { kind: 'widgets' })).toBeUndefined()
})

test('recordMetrics passes the record time to the kind', async () => {
  const { analyses } = memoryStore()
  const stamped = defineAnalysis<{ count: number }, { at?: string }>({
    ...widgets,
    metrics: (_data, { createdAt }) => (createdAt ? { at: createdAt } : {}),
  })
  expect(
    await recordMetrics(analyses, stamped, {
      repo,
      createdAt: '2026-11-03T00:00:00Z',
      data: { count: 1 },
    }),
  ).toEqual({ at: '2026-11-03T00:00:00Z' })
  expect(await recordMetrics(analyses, stamped, { repo, data: { count: 1 } })).toEqual({})
})
