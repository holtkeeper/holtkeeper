import { expect, test } from 'bun:test'

import type { Asset } from './data.ts'
import {
  assetsPolicyFacts,
  byteLimits,
  defaultAssetsPolicy,
  isIgnored,
  parseAssetsPolicy,
  policyViolations,
  worthSaving,
} from './policy.ts'

const asset = (path: string, bytes: number, extra: Partial<Asset> = {}): Asset => ({
  path,
  kind: 'image',
  format: path.slice(path.lastIndexOf('.') + 1),
  bytes,
  hash: path,
  origin: 'source',
  ...extra,
})

test('the default policy asks for WebP, warns at 500 kB and ignores vendored files', () => {
  expect(defaultAssetsPolicy.formats).toEqual({ raster: 'webp', svg: 'optimize' })
  expect(byteLimits(defaultAssetsPolicy, 'image')).toEqual({ warn: 500_000, error: 1_000_000 })
  expect(isIgnored('vendor/lib/logo.png', defaultAssetsPolicy)).toBe(true)
  expect(isIgnored('public/app.min.js', defaultAssetsPolicy)).toBe(true)
  expect(isIgnored('public/logo.png', defaultAssetsPolicy)).toBe(false)
  expect(parseAssetsPolicy({ maxDimension: 'huge' })).toEqual(defaultAssetsPolicy)
})

test('per-kind limits replace the general ones field by field', () => {
  const policy = parseAssetsPolicy({ maxBytes: { perKind: { audio: { error: 3_000_000 } } } })
  expect(byteLimits(policy, 'audio')).toEqual({ warn: 500_000, error: 3_000_000 })
  expect(byteLimits(policy, 'font')).toEqual({ warn: 500_000, error: 1_000_000 })
})

test('violations cover formats, sizes, dimensions, modern siblings and budgets', () => {
  const policy = parseAssetsPolicy({
    formats: { raster: 'avif+webp', allowed: ['png', 'webp', 'mp3'] },
    maxBytes: { warn: 10_000, error: 50_000 },
    maxDimension: 1000,
    budgets: { total: 200_000, perKind: { audio: 20_000 } },
  })
  const violations = policyViolations(
    [
      asset('public/hero.png', 60_000, { image: { width: 1600, height: 900 } }),
      asset('public/hero.webp', 9_000, { image: { width: 1600, height: 900 } }),
      asset('public/icon.bmp', 2_000),
      asset('public/sfx/hit.mp3', 30_000, { kind: 'audio' }),
      asset('vendor/big.png', 900_000),
      asset('dist/hero.png', 60_000, { origin: 'build', hash: 'public/hero.png' }),
    ],
    policy,
  )
  expect(violations.map((violation) => [violation.id, violation.severity])).toEqual([
    ['budget:audio', 'error'],
    ['max-bytes:public/hero.png', 'error'],
    ['format:public/icon.bmp', 'error'],
    ['max-dimension:public/hero.png', 'warning'],
    ['modern-format:public/hero.png', 'warning'],
    ['max-dimension:public/hero.webp', 'warning'],
    ['max-bytes:public/sfx/hit.mp3', 'warning'],
  ])
  expect(violations.find((v) => v.rule === 'modern-format')?.message).toBe(
    'no AVIF version next to it',
  )
})

test('keep asks for no sibling and a total budget counts every file once', () => {
  const policy = parseAssetsPolicy({ formats: { raster: 'keep' }, budgets: { total: 10_000 } })
  expect(
    policyViolations([asset('a/b.png', 9_000), asset('a/c.png', 9_000)], policy).map((v) => v.id),
  ).toEqual(['budget:total'])
})

test('a saving must clear both the percent and the bytes of minSaving', () => {
  expect(worthSaving(defaultAssetsPolicy, 100_000, 6_000)).toBe(true)
  expect(worthSaving(defaultAssetsPolicy, 100_000, 3_000)).toBe(false)
  expect(worthSaving(defaultAssetsPolicy, 10_000, 900)).toBe(false)
})

test('the policy reads as plain facts for prompts', () => {
  const facts = assetsPolicyFacts(
    parseAssetsPolicy({ formats: { allowed: ['webp', 'svg'] }, budgets: { total: 2_000_000 } }),
  )
  expect(facts.split('\n')).toEqual([
    '- PNG, JPEG and GIF images from 8 kB ship with a WEBP version.',
    '- SVG files and inline SVGs are optimized with svgo.',
    '- Only these file formats are allowed: webp, svg.',
    '- A file above 500 kB is a warning, above 1 MB an error.',
    '- Images and videos are at most 2560 px wide or tall.',
    '- Budgets: all assets 2 MB.',
    '- Not checked: `vendor/**`, `**/*.min.*`, `fixtures/**`.',
  ])
})
