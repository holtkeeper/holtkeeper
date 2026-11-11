import { expect, test } from 'bun:test'

import { defineAnalysis } from '@holtkeeper/report'
import { z } from 'zod'

import { summarizeAnalysis } from '../src/analyses.ts'

const widgets = defineAnalysis<{ count: number }>({
  kind: 'widgets',
  label: 'Widgets',
  schema: z.object({ count: z.number() }),
  summarize: (data) => [{ id: 'count', label: 'Count', value: data.count.valueOf() }],
  toReport: () => {
    throw new Error('not used')
  },
})

const record = (kind: string, data: unknown) => ({
  id: 'r1',
  repo: { forge: 'work', path: 'shapes/a' },
  kind,
  createdAt: '2026-11-01T00:00:00.000Z',
  data,
})

test('records of unknown kinds or an older data shape list without metrics', () => {
  const kinds = new Map([['widgets', widgets]])
  expect(summarizeAnalysis(kinds, record('widgets', { count: 2 })).metrics).toEqual([
    { id: 'count', label: 'Count', value: 2 },
  ])
  expect(summarizeAnalysis(kinds, record('widgets', {}))).toMatchObject({
    label: 'Widgets',
    metrics: [],
  })
  expect(summarizeAnalysis(kinds, record('retired', { count: 1 }))).toMatchObject({
    label: 'retired',
    metrics: [],
  })
})
