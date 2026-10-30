import { describe, expect, test } from 'bun:test'

import type { Block } from '@holtkeeper/api'

import { heatLimit, heatOf, labelStep } from './heatmap.ts'

type Heatmap = Extract<Block, { type: 'heatmap' }>

const block = (scale: Heatmap['scale']): Heatmap => ({
  type: 'heatmap',
  xLabels: ['a', 'b'],
  yRows: [
    { label: 'x', cells: [{ value: -30 }, null] },
    { label: 'y', cells: [{ value: 10 }, { value: 20 }] },
  ],
  scale,
})

describe('heatmap colors', () => {
  test('the limit is given or the largest magnitude', () => {
    expect(heatLimit(block({ kind: 'diverging', better: 'down' }))).toBe(30)
    expect(heatLimit(block({ kind: 'diverging', better: 'down', limit: 50 }))).toBe(50)
    expect(heatLimit(block({ kind: 'sequential', tone: 'bad' }))).toBe(30)
  })

  test('diverging values color by the better direction and saturate', () => {
    const scale = { kind: 'diverging', better: 'down' } as const
    expect(heatOf(25, scale, 50)).toEqual({ tone: 'bad', strength: 0.5 })
    expect(heatOf(-80, scale, 50)).toEqual({ tone: 'good', strength: 1 })
    expect(heatOf(0, scale, 50)).toEqual({ tone: 'neutral', strength: 0 })
  })

  test('sequential values use the scale tone', () => {
    expect(heatOf(5, { kind: 'sequential', tone: 'bad' }, 20)).toEqual({
      tone: 'bad',
      strength: 0.25,
    })
    expect(heatOf(0, { kind: 'sequential', tone: 'bad' }, 20).strength).toBe(0)
  })

  test('labels thin out on wide heatmaps', () => {
    expect(labelStep(10)).toBe(1)
    expect(labelStep(26)).toBe(3)
  })
})
