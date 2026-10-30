import { expect, test } from 'bun:test'

import { asset } from '../test/assets.ts'
import { evaluateBudgets, overBudgetCount, totalsOf } from './budgets.ts'

const assets = [
  asset('public/bg.png', { bytes: 500_000, image: { width: 4096, height: 2048 } }),
  asset('public/icon.png', { bytes: 2000, image: { width: 64, height: 64 } }),
  asset('public/music.ogg', { kind: 'audio', bytes: 3_000_000 }),
  asset('dist/bg.png', { bytes: 500_000, origin: 'build', hash: 'hash-public/bg.png' }),
  asset('dist/other.png', { bytes: 10, origin: 'build' }),
]

test('totals count build copies of source files once', () => {
  expect(totalsOf(assets)).toEqual([
    { kind: 'image', count: 3, bytes: 502_010 },
    { kind: 'audio', count: 1, bytes: 3_000_000 },
  ])
})

test('per-asset budgets check bytes and dimensions, filtered by pattern and kind', () => {
  const violations = evaluateBudgets(assets, [
    { pattern: 'public/**', maxBytes: 100_000, kind: 'image' },
    { pattern: 'public/*.png', maxWidth: 2048, maxHeight: 2048 },
  ])
  expect(violations.map((violation) => violation.id)).toEqual([
    'bytes:public/**:public/bg.png',
    'width:public/*.png:public/bg.png',
  ])
  expect(violations[1]).toMatchObject({ actual: 4096, max: 2048, limit: 'width' })
})

test('total budgets per kind', () => {
  const violations = evaluateBudgets(assets, [], { audio: 1_000_000, image: 1_000_000 })
  expect(violations).toEqual([
    { id: 'total:audio', kind: 'audio', limit: 'total', actual: 3_000_000, max: 1_000_000 },
  ])
  expect(
    overBudgetCount([
      ...violations,
      ...evaluateBudgets(assets, [{ pattern: '**', maxBytes: 1, maxWidth: 1 }]),
    ]),
  ).toBe(6)
})
