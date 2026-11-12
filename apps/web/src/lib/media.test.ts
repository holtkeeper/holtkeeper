import { describe, expect, test } from 'bun:test'

import type { MediaVariantsResult } from '@holtkeeper/api'

import {
  configSummary,
  conflictIds,
  deliverBlocker,
  duplicatePaths,
  initialSelection,
  mediaTitle,
  offeredVariants,
  pathError,
  replacementOf,
  selectionText,
  stepState,
  emptyMediaDraft,
  formatSavings,
  parseNumbers,
  savingsTone,
  snippetLabel,
  toVariantsInput,
  validateDensity,
  validateMediaDraft,
  validateQuality,
  validateWidth,
} from './media.ts'

describe('validators', () => {
  test('widths are whole pixels up to 8192', () => {
    expect(validateWidth('640')).toBeUndefined()
    expect(validateWidth('8192')).toBeUndefined()
    expect(validateWidth('0')).toBeDefined()
    expect(validateWidth('8193')).toBeDefined()
    expect(validateWidth('12.5')).toBeDefined()
    expect(validateWidth('wide')).toBeDefined()
  })

  test('densities accept an x suffix', () => {
    expect(validateDensity('2')).toBeUndefined()
    expect(validateDensity('1.5x')).toBeUndefined()
    expect(validateDensity('0')).toBeDefined()
    expect(validateDensity('5')).toBeDefined()
  })

  test('quality is optional', () => {
    expect(validateQuality('')).toBeUndefined()
    expect(validateQuality('80')).toBeUndefined()
    expect(validateQuality('101')).toBeDefined()
    expect(validateQuality('7.5')).toBeDefined()
  })

  test('the draft needs a relative file path', () => {
    expect(validateMediaDraft(emptyMediaDraft).file).toBeDefined()
    expect(validateMediaDraft({ ...emptyMediaDraft, file: '/a.png' }).file).toBeDefined()
    expect(validateMediaDraft({ ...emptyMediaDraft, file: 'public/a.png' })).toEqual({})
  })
})

test('parseNumbers sorts, de-duplicates and drops invalid entries', () => {
  expect(parseNumbers(['1280', '640', '640', 'x', '2x'])).toEqual([2, 640, 1280])
})

describe('toVariantsInput', () => {
  test('leaves empty fields to the server', () => {
    expect(
      toVariantsInput('acme:acme/widgets', { ...emptyMediaDraft, file: ' hero.png ' }),
    ).toEqual({
      repo: 'acme:acme/widgets',
      file: 'hero.png',
    })
  })

  test('sends what was set', () => {
    expect(
      toVariantsInput('acme:acme/widgets', {
        file: 'hero.png',
        ref: 'main',
        formats: ['avif'],
        widths: ['960', '320'],
        densities: ['2x'],
        quality: '70',
        preset: 'max',
      }),
    ).toEqual({
      repo: 'acme:acme/widgets',
      file: 'hero.png',
      ref: 'main',
      formats: ['avif'],
      widths: [320, 960],
      densities: [2],
      quality: 70,
      preset: 'max',
    })
  })
})

test('savingsTone and formatSavings', () => {
  expect(savingsTone(55)).toBe('success')
  expect(savingsTone(10)).toBe('accent')
  expect(savingsTone(0)).toBe('default')
  expect(savingsTone(-3)).toBe('danger')
  expect(formatSavings(42.4)).toBe('-42%')
  expect(formatSavings(-8)).toBe('+8%')
  expect(formatSavings(0.2)).toBe('0%')
})

test('snippetLabel', () => {
  expect(snippetLabel('html')).toBe('HTML')
  expect(snippetLabel('solid')).toBe('Solid')
})

test('duplicatePaths', () => {
  expect([...duplicatePaths(['a.webp', 'b.webp', ' a.webp'])]).toEqual(['a.webp'])
})

test('steps before the current one are done, later ones to do', () => {
  expect(stepState('configure', 'markup')).toBe('done')
  expect(stepState('markup', 'markup')).toBe('current')
  expect(stepState('deliver', 'variants')).toBe('todo')
})

test('the sent draft reads as labelled lines', () => {
  const empty = Object.fromEntries(
    configSummary(emptyMediaDraft).map((line) => [line.label, line.value]),
  )
  expect(empty).toEqual({
    Formats: 'AVIF, WebP and the source format',
    Widths: 'responsive ladder up to the source width',
    Densities: 'none',
    'Effort · quality': 'Default · tuned (AVIF 55, WebP and JPEG 78)',
    'Read from': 'default branch',
  })
  const set = Object.fromEntries(
    configSummary({
      file: 'a.png',
      ref: ' main ',
      formats: ['avif', 'webp'],
      widths: ['1280', '640'],
      densities: ['2x', '1'],
      quality: '70',
      preset: 'max',
    }).map((line) => [line.label, line.value]),
  )
  expect(set).toEqual({
    Formats: 'AVIF, WEBP',
    Widths: '640, 1280 px',
    Densities: '@1x, @2x',
    'Effort · quality': 'Max · q70',
    'Read from': 'main',
  })
})

const variant = (id: string, path: string, bytes = 100) => ({
  id,
  format: path.split('.').at(-1) ?? 'webp',
  width: 640,
  height: 480,
  quality: 78,
  bytes,
  savingsPercent: 50,
  path,
})

const result = (extra: Partial<MediaVariantsResult> = {}): MediaVariantsResult => ({
  original: { bytes: 1000, width: 1280, height: 960, format: 'png', sha256: 'f00' },
  variants: [
    variant('v1', 'img/hero-640.webp', 100),
    variant('v2', 'img/hero-640.avif', 80),
    variant('v3', 'img/hero.png', 700),
  ],
  snippets: {},
  savings: { originalBytes: 1000, formats: [], bestSavingsPercent: 92 },
  exists: { 'img/hero-640.webp': true, 'img/hero-640.avif': false, 'img/hero.png': true },
  ...extra,
})

test('the re-encoded original or the optimized SVG replaces the file', () => {
  expect(replacementOf(result(), 'img/hero.png')).toBe('v3')
  expect(replacementOf(result(), 'img/other.png')).toBeUndefined()
  expect(
    replacementOf(result({ svg: { id: 's1', before: 10, after: 5, breakdown: {} } }), 'a.svg'),
  ).toBe('s1')
  expect(offeredVariants(result(), ' img/hero.png ').map((v) => v.id)).toEqual(['v1', 'v2'])
})

test('variants start chosen unless their path already exists', () => {
  expect(initialSelection(result(), 'img/hero.png')).toEqual(['v2'])
  expect(initialSelection(result(), 'img/other.png')).toEqual(['v2'])
})

test('a conflict is a chosen variant kept at an existing suggested path', () => {
  const data = result()
  expect(conflictIds(data, ['v1', 'v2'], {})).toEqual(['v1'])
  expect(conflictIds(data, ['v1', 'v2'], { v1: 'img/hero-640-new.webp' })).toEqual([])
  expect(conflictIds(data, ['v2'], {})).toEqual([])
})

test('path errors name the first problem', () => {
  const ok = { duplicate: false, exists: false, ref: '' }
  expect(pathError(' ', ok)).toBe('Enter a path')
  expect(pathError('a.webp', { ...ok, duplicate: true, exists: true })).toBe(
    'Another variant uses this path',
  )
  expect(pathError('a.webp', { ...ok, exists: true })).toBe('Already exists on the default branch')
  expect(pathError('a.webp', { ...ok, exists: true, ref: 'main' })).toBe('Already exists on main')
  expect(pathError('a.webp', ok)).toBeUndefined()
})

test('selection and delivery read as short text', () => {
  const offered = [variant('v1', 'a.webp', 1000), variant('v2', 'a.avif', 500)]
  expect(selectionText(offered, ['v1', 'v2'])).toBe('2 of 2 chosen, 1.5 kB added')
  expect(selectionText(offered, [])).toBe('0 of 2 chosen')
  const clear = { chosen: 1, replace: false, emptyPaths: 0, duplicates: 0, conflicts: 0 }
  expect(deliverBlocker(clear)).toBeUndefined()
  expect(deliverBlocker({ ...clear, chosen: 0 })).toBe('Choose a variant or replace the original')
  expect(deliverBlocker({ ...clear, chosen: 0, replace: true })).toBeUndefined()
  expect(deliverBlocker({ ...clear, emptyPaths: 1 })).toBe('Enter a path for every chosen variant')
  expect(deliverBlocker({ ...clear, duplicates: 1 })).toBe('Give every chosen variant its own path')
  expect(deliverBlocker({ ...clear, conflicts: 1 })).toBe('Fix 1 conflict to continue')
  expect(deliverBlocker({ ...clear, conflicts: 2 })).toBe('Fix 2 conflicts to continue')
  expect(mediaTitle('public/img/hero.png')).toBe('Optimize hero.png')
  expect(mediaTitle(' ')).toBe('Optimize image')
})
