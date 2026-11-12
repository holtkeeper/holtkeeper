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

const normalized = (files: string[]) => [...normalizeAssetNames(files).values()]

describe('normalizeAssetNames', () => {
  test('learns hashes that look like words from the rest of the build', () => {
    expect(
      normalized(['chunk-rkgagbvp.js', 'index-0mn929mj.js', 'admin-ye8pgm9b.js', 'polyfills.js']),
    ).toEqual(['chunk.js', 'index.js', 'admin.js', 'polyfills.js'])
  })

  test('learns from a single recognised hash', () => {
    expect(
      normalized(['index-kdfefdxf.js', 'admin-q8wz1kpa.js', 'chunk-rkgagbvp.js', 'styles.css']),
    ).toEqual(['index.js', 'admin.js', 'chunk.js', 'styles.css'])
  })

  test('recognises a build whose hashes are all letters by a repeated stem', () => {
    expect(
      normalized([
        'index-kdfefdxf.js',
        'admin-qwzrkpan.js',
        'chunk-rkgagbvp.js',
        'chunk-mnbvcxzq.js',
        'index.html',
        'styles.css',
      ]),
    ).toEqual(['index.js', 'admin.js', 'chunk.js', 'chunk.js', 'index.html', 'styles.css'])
  })

  test('recognises uppercase base32 hashes', () => {
    expect(
      normalized(['out/main-QWERTYUI.js', 'out/chunk-ASDFGHJK.js', 'out/chunk-ZXCVBNMQ.js']),
    ).toEqual(['out/main.js', 'out/chunk.js', 'out/chunk.js'])
  })

  test.each([
    [['app-frontend.js']],
    [['locale-english.js', 'locale-french.js', 'locale-german.js']],
    [['icon-squirrel.svg', 'icon-pinecone.svg', 'index-0mn929mj.js']],
    [['shape-circle.js', 'shape-square.js', 'shape-triangle.js']],
    [['polyfills-legacy.js', 'vendor-react.js', 'index-0mn929mj.js']],
    [['theme-midnight.css', 'index-0mn929mj.js']],
    [['locale-german.js', 'locale-french.js']],
    [['route-signup.js', 'route-search.js']],
    [['icon-button.js', 'icon-header.js']],
    [['js/vendor-lodash.js', 'js/vendor-moment.js', 'js/app-common.js', 'js/page-signup.js']],
    [['shape-pentagon.js', 'shape-triangle.js', 'shape-trapezoid.js']],
  ])('keeps word suffixes in %j', (files) => {
    const names = normalizeAssetNames(files)
    for (const file of files.filter((name) => !name.startsWith('index-')))
      expect(names.get(file)).toBe(file)
  })
})
