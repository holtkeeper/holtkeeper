import { describe, expect, test } from 'bun:test'

import {
  duplicatePaths,
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
    expect(toVariantsInput('gitlab:team/app', { ...emptyMediaDraft, file: ' hero.png ' })).toEqual({
      repo: 'gitlab:team/app',
      file: 'hero.png',
    })
  })

  test('sends what was set', () => {
    expect(
      toVariantsInput('gitlab:team/app', {
        file: 'hero.png',
        ref: 'main',
        formats: ['avif'],
        widths: ['960', '320'],
        densities: ['2x'],
        quality: '70',
        preset: 'max',
      }),
    ).toEqual({
      repo: 'gitlab:team/app',
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
