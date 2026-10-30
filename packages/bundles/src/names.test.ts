import { describe, expect, test } from 'bun:test'

import { assetKind, normalizeAssetName, normalizeAssetNames } from './names.ts'

describe('normalizeAssetName', () => {
  test.each([
    ['assets/index-B3x9kQ.js', 'assets/index.js'],
    ['assets/index-B3x9kQz1.js', 'assets/index.js'],
    ['assets/index-B3x-kQz1.js', 'assets/index.js'],
    ['assets/vendor-react-a1b2c3d4.js', 'assets/vendor-react.js'],
    ['index-0mn929mj.js', 'index.js'],
    ['main.3f2a1b9c.css', 'main.css'],
    ['static/js/main.3f2a1b9c4d5e6f708192.chunk.js', 'static/js/main.chunk.js'],
    ['3f2a1b9c4d5e6f70.js', 'chunk.js'],
    ['assets/logo.abcdef12.svg', 'assets/logo.svg'],
    ['assets/font-Inter_V2x.woff2', 'assets/font.woff2'],
  ])('%s → %s', (file, expected) => {
    expect(normalizeAssetName(file)).toBe(expected)
  })

  test.each([
    'index.html',
    'assets/vendor.js',
    'polyfills-legacy.js',
    'jquery.min.js',
    'admin/index.html',
    'LICENSE',
  ])('keeps %s', (file) => {
    expect(normalizeAssetName(file)).toBe(file)
  })
})

test('assetKind', () => {
  expect(assetKind('a/b.mjs')).toBe('js')
  expect(assetKind('a.CSS')).toBe('css')
  expect(assetKind('index.html')).toBe('html')
  expect(assetKind('logo.svg')).toBe('image')
  expect(assetKind('inter.woff2')).toBe('font')
  expect(assetKind('robots.txt')).toBe('other')
  expect(assetKind('LICENSE')).toBe('other')
})

test('normalizeAssetNames learns hashes that look like words from the rest of the build', () => {
  const names = normalizeAssetNames([
    'chunk-rkgagbvp.js',
    'index-0mn929mj.js',
    'admin-ye8pgm9b.js',
    'polyfills.js',
  ])
  expect([...names.values()]).toEqual(['chunk.js', 'index.js', 'admin.js', 'polyfills.js'])
  expect(normalizeAssetNames(['app-frontend.js']).get('app-frontend.js')).toBe('app-frontend.js')
})
