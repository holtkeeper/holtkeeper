import { expect, test } from 'bun:test'

import type { BundleData } from './data.ts'
import { bundleMetrics, judgeTarget } from './metrics.ts'
import type { BundleTarget } from './targets.ts'

const build = (js: number, css = 0): BundleData => ({
  assets: [
    { file: 'main.js', name: 'main.js', kind: 'js', raw: js * 3, gzip: js, brotli: js, mapped: 0 },
    {
      file: 'main.css',
      name: 'main.css',
      kind: 'css',
      raw: css * 3,
      gzip: css,
      brotli: css,
      mapped: 0,
    },
    {
      file: 'logo.png',
      name: 'logo.png',
      kind: 'image',
      raw: 500,
      gzip: 500,
      brotli: 500,
      mapped: 0,
    },
  ],
  entrypoints: [
    {
      name: 'main',
      initial: ['main.js', 'main.css'],
      lazy: [],
      initialSize: { raw: 0, gzip: js + css, brotli: 0 },
      lazySize: { raw: 0, gzip: 0, brotli: 0 },
      packages: [],
      modules: [],
    },
  ],
  packages: [],
  modules: [],
  unmapped: 0,
})

const target = (name: string, data?: BundleData, version?: string): BundleTarget => ({
  name,
  source: version ? 'package' : 'build',
  ...(version ? { version } : {}),
  status: data ? 'ok' : 'failed',
  ...(data ? { data } : { error: 'build failed' }),
})

test('metrics: gzip per target, delta and verdict against budgets', () => {
  const data = {
    targets: [
      target('web', build(950, 50)),
      target('@acme/widget', build(80), '1.0.0'),
      target('@acme/widget', build(95), '1.2.0'),
      target('docs', build(10)),
      target('admin'),
    ],
  }
  const metrics = bundleMetrics(data, {
    options: { budgets: { web: 2000, '@acme/*': 100, '*': 5 } },
    previous: { targets: [{ name: 'web', source: 'build', status: 'ok', gzip: 900 }], failed: 0 },
  })
  expect(metrics).toEqual({
    targets: [
      {
        name: '@acme/widget',
        source: 'package',
        version: '1.2.0',
        status: 'ok',
        gzip: 95,
        initial: 95,
        budget: 100,
        verdict: 'near',
      },
      { name: 'admin', source: 'build', status: 'failed', budget: 5 },
      {
        name: 'docs',
        source: 'build',
        status: 'ok',
        gzip: 10,
        initial: 10,
        budget: 5,
        verdict: 'over',
      },
      {
        name: 'web',
        source: 'build',
        status: 'ok',
        gzip: 1000,
        initial: 1000,
        delta: 100,
        budget: 2000,
        verdict: 'ok',
      },
    ],
    failed: 1,
  })
  expect(bundleMetrics(build(10))).toEqual({
    targets: [{ name: 'app', source: 'build', status: 'ok', gzip: 10, initial: 10 }],
    failed: 0,
  })
  expect(
    bundleMetrics(build(10), { options: { budgets: { app: 'big' } } }).targets[0],
  ).not.toHaveProperty('budget')
})

test('judgeTarget: the current budgets win over the stored budget', () => {
  const stored = { name: 'web', gzip: 950, budget: 2000 }
  expect(judgeTarget(stored, undefined)).toEqual({ budget: 2000, verdict: 'ok' })
  expect(judgeTarget(stored, { 'w*': 1000 })).toEqual({ budget: 1000, verdict: 'near' })
  expect(judgeTarget(stored, { web: 900 })).toEqual({ budget: 900, verdict: 'over' })
  expect(judgeTarget(stored, { other: 900 })).toEqual({})
  expect(judgeTarget({ name: 'web', budget: 10 }, undefined)).toEqual({ budget: 10 })
  expect(judgeTarget({ name: 'web', gzip: 5 }, undefined)).toEqual({})
})
