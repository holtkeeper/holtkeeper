import { expect, test } from 'bun:test'

import { asset } from '../test/assets.ts'
import { totalsOf } from './budgets.ts'
import { compareAssets } from './compare.ts'
import type { Asset, AssetsData } from './data.ts'

const data = (assets: Asset[], budgets: AssetsData['budgets'] = []): AssetsData => ({
  roots: [],
  engines: [],
  convert: 'estimate',
  tools: [],
  assets,
  totals: totalsOf(assets),
  budgets,
  findings: [],
  suggestions: [],
  duplicates: [],
})

test('matches by path, detects renames by hash, sums kinds', () => {
  const previous = data(
    [
      asset('a.png', { bytes: 100, hash: 'a' }),
      asset('b.png', { bytes: 200, hash: 'b' }),
      asset('old.png', { bytes: 300, hash: 'moved' }),
      asset('gone.wav', { kind: 'audio', bytes: 400, hash: 'gone' }),
      asset('same.png', { bytes: 50, hash: 'same' }),
    ],
    [{ id: 'total:audio', kind: 'audio', limit: 'total', actual: 400, max: 1 }],
  )
  const current = data(
    [
      asset('a.png', { bytes: 150, hash: 'a2' }),
      asset('b.png', { bytes: 120, hash: 'b2' }),
      asset('new/old.png', { bytes: 300, hash: 'moved' }),
      asset('new.woff2', { kind: 'font', bytes: 80, hash: 'font' }),
      asset('same.png', { bytes: 50, hash: 'same' }),
    ],
    [{ id: 'total:font', kind: 'font', limit: 'total', actual: 80, max: 1 }],
  )
  const comparison = compareAssets(previous, current)
  expect(comparison.assets).toEqual([
    { status: 'removed', path: 'gone.wav', kind: 'audio', previousBytes: 400, delta: -400 },
    { status: 'shrunk', path: 'b.png', kind: 'image', previousBytes: 200, bytes: 120, delta: -80 },
    { status: 'added', path: 'new.woff2', kind: 'font', bytes: 80, delta: 80 },
    { status: 'grown', path: 'a.png', kind: 'image', previousBytes: 100, bytes: 150, delta: 50 },
    {
      status: 'renamed',
      path: 'new/old.png',
      kind: 'image',
      previousPath: 'old.png',
      previousBytes: 300,
      bytes: 300,
      delta: 0,
    },
  ])
  expect(comparison.kinds).toEqual([
    { kind: 'image', previous: 650, current: 620, delta: -30, previousCount: 4, currentCount: 4 },
    { kind: 'audio', previous: 400, current: 0, delta: -400, previousCount: 1, currentCount: 0 },
    { kind: 'font', previous: 0, current: 80, delta: 80, previousCount: 0, currentCount: 1 },
  ])
  expect(comparison.total).toEqual({ previous: 1050, current: 700, delta: -350 })
  expect(comparison.newViolations).toEqual(['total:font'])
  expect(comparison.resolvedViolations).toEqual(['total:audio'])
})
