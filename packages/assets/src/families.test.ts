import { expect, test } from 'bun:test'

import { asset } from '../test/assets.ts'
import { hasModernFormats, hasSizes, imageFamilies, variantPaths } from './families.ts'
import { deliveryIssues } from './findings.ts'

const big = { image: { width: 2400, height: 1600 }, bytes: 400_000 }

test('groups formats, widths and densities next to the original', () => {
  const families = imageFamilies([
    asset('public/hero.png', big),
    asset('public/hero.webp'),
    asset('public/hero-640w.avif', { format: 'avif' }),
    asset('public/hero-1280w.webp'),
    asset('public/icon@2x.png', { image: { width: 128, height: 128 } }),
    asset('public/icon@1x.png', { image: { width: 64, height: 64 } }),
    asset('public/other/hero.png'),
    asset('public/logo.svg', { format: 'svg' }),
    asset('dist/hero.png', { origin: 'build' }),
  ])
  expect(
    families.map((family) => [
      family.original.path,
      family.members.map((member) => member.path),
      [...family.formats].toSorted(),
      family.widths,
      family.densities,
    ]),
  ).toEqual([
    [
      'public/hero.png',
      ['public/hero.webp', 'public/hero-640w.avif', 'public/hero-1280w.webp'],
      ['avif', 'png', 'webp'],
      [640, 1280],
      [],
    ],
    ['public/icon@2x.png', ['public/icon@1x.png'], ['png'], [], [1]],
    ['public/other/hero.png', [], ['png'], [], []],
  ])
  const [hero, icon, other] = families
  expect(hero && hasModernFormats(hero) && hasSizes(hero)).toBe(true)
  expect(icon && hasSizes(icon)).toBe(true)
  expect(other && hasSizes(other)).toBe(false)
  expect([...variantPaths(families)]).toContain('public/hero-640w.avif')
})

test('reports rasters without modern formats and large single-resolution images', () => {
  const families = imageFamilies([
    asset('public/hero.png', big),
    asset('public/done.jpg', { ...big, format: 'jpg' }),
    asset('public/done.avif', { format: 'avif' }),
    asset('public/done.webp'),
    asset('public/done-640w.webp'),
    asset('public/half.png', { bytes: 20_000, image: { width: 400, height: 300 } }),
    asset('public/half.webp'),
    asset('public/tiny.png', { bytes: 500 }),
  ])
  expect(
    deliveryIssues(families, { engines: [] }).map((finding) => [finding.id, finding.tone]),
  ).toEqual([
    ['missing-modern-formats:public/hero.png', 'warning'],
    ['single-resolution:public/hero.png', 'warning'],
  ])
  expect(
    deliveryIssues(families, { engines: [], avif: true }).map((finding) => [
      finding.id,
      finding.tone,
    ]),
  ).toEqual([
    ['missing-modern-formats:public/half.png', 'info'],
    ['missing-modern-formats:public/hero.png', 'warning'],
    ['single-resolution:public/hero.png', 'warning'],
  ])
  expect(
    deliveryIssues(families, { engines: ['pixi'] }).find(
      (finding) => finding.rule === 'single-resolution',
    )?.tone,
  ).toBe('info')
})

test('a bare -{n} suffix is a size only when n is the width or height', () => {
  const families = imageFamilies([
    asset('assets/snowy-720.webp', { image: { width: 1280, height: 720 } }),
    asset('assets/snowy-1080.webp', { image: { width: 1920, height: 1080 } }),
    asset('assets/snowy-1620.webp', { image: { width: 2880, height: 1620 }, bytes: 300_000 }),
    asset('assets/snowy-1620.avif', { format: 'avif', image: { width: 2880, height: 1620 } }),
    asset('assets/icon-256.webp', { image: { width: 256, height: 256 } }),
    asset('assets/level-1.png', { image: { width: 800, height: 600 } }),
    asset('assets/level-2.png', { image: { width: 800, height: 600 } }),
  ])
  expect(
    families.map((family) => [
      family.original.path,
      family.members.map((member) => member.path),
      family.widths,
    ]),
  ).toEqual([
    ['assets/icon-256.webp', [], []],
    ['assets/level-1.png', [], []],
    ['assets/level-2.png', [], []],
    [
      'assets/snowy-1620.webp',
      ['assets/snowy-720.webp', 'assets/snowy-1080.webp', 'assets/snowy-1620.avif'],
      [1280, 1920, 2880],
    ],
  ])
  const snowy = families.at(-1)
  expect(snowy && hasSizes(snowy) && hasModernFormats(snowy)).toBe(true)
  expect(snowy && hasModernFormats(snowy, true)).toBe(true)
  expect(deliveryIssues(families, { engines: [] })).toEqual([])
})
