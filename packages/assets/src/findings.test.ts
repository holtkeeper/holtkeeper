import { expect, test } from 'bun:test'

import { asset } from '../test/assets.ts'
import { findDuplicates, findIssues, wasted } from './findings.ts'

test('huge and non-power-of-two images, unused hints', () => {
  const assets = [
    asset('huge.png', { image: { width: 8192, height: 1024 } }),
    asset('npot.png', { image: { width: 300, height: 256 } }),
    asset('tiny.png', { image: { width: 30, height: 20 } }),
    asset('logo.svg', { image: { width: 5000, height: 5000, codec: 'vector' } }),
    asset('unused.png', { referenced: false }),
    asset('dist/huge.png', { origin: 'build', image: { width: 8192, height: 8192 } }),
  ]
  expect(findIssues(assets, { engines: [] }).map((finding) => finding.id)).toEqual([
    'huge-dimensions:huge.png',
    'unused:unused.png',
  ])
  expect(findIssues(assets, { engines: ['phaser'] }).map((finding) => finding.id)).toEqual([
    'huge-dimensions:huge.png',
    'non-power-of-two:npot.png',
    'unused:unused.png',
  ])
})

test('duplicates group by content within an origin, most waste first', () => {
  const duplicates = findDuplicates([
    asset('a.png', { hash: 'x', bytes: 10 }),
    asset('b.png', { hash: 'x', bytes: 10 }),
    asset('c.png', { hash: 'x', bytes: 10 }),
    asset('big1.wav', { hash: 'y', bytes: 1000 }),
    asset('big2.wav', { hash: 'y', bytes: 1000 }),
    asset('dist/big1.wav', { hash: 'y', bytes: 1000, origin: 'build' }),
    asset('single.png', { hash: 'z' }),
  ])
  expect(duplicates).toEqual([
    { hash: 'y', bytes: 1000, paths: ['big1.wav', 'big2.wav'] },
    { hash: 'x', bytes: 10, paths: ['a.png', 'b.png', 'c.png'] },
  ])
  expect(duplicates.map(wasted)).toEqual([1000, 20])
})
