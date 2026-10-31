import { expect, test } from 'bun:test'

import type { SettingView } from '@holtkeeper/api'

import { excludeChoices, excludeEntry, globEscape } from './exclude.ts'

const repo = { forge: 'work', path: 'games/app' }
const entry = (scope: SettingView['scope'], value: unknown): SettingView => ({
  id: 'entry-1',
  key: 'analyzers.assets',
  scope,
  value,
  secret: false,
  updatedAt: '2026-10-31T00:00:00.000Z',
})

test('escaped globs match only the file they name', () => {
  const path = 'src/sprites/[TenRanges]/Canvas{1}.png'
  expect(globEscape(path)).toBe('src/sprites/\\[TenRanges\\]/Canvas\\{1\\}.png')
  expect(new Bun.Glob(globEscape(path)).match(path)).toBe(true)
  expect(new Bun.Glob(globEscape(path)).match('src/sprites/T/Canvas1.png')).toBe(false)
})

test('offers the file, its kind in the folder, every folder and the name anywhere', () => {
  const path = 'src/sprites/[Main]/Win.png'
  const choices = excludeChoices(path)
  expect(choices.map((choice) => choice.pattern)).toEqual([
    'src/sprites/\\[Main\\]/Win.png',
    'src/sprites/\\[Main\\]/*.png',
    'src/sprites/\\[Main\\]/**',
    'src/sprites/**',
    'src/**',
    '**/Win.png',
  ])
  for (const choice of choices) expect(new Bun.Glob(choice.pattern).match(path)).toBe(true)
  expect(excludeChoices('logo.svg').map((choice) => choice.pattern)).toEqual(['logo.svg', '*.svg'])
})

test('extends the repository entry in place and keeps other options', () => {
  const own = entry({ repos: ['work:games/app'] }, { optimizeTop: 5, optimizeIgnore: ['a/**'] })
  expect(excludeEntry('analyzers.assets', 'optimizeIgnore', 'b/**', repo, own)).toEqual({
    id: 'entry-1',
    key: 'analyzers.assets',
    scope: { repos: ['work:games/app'] },
    value: { optimizeTop: 5, optimizeIgnore: ['a/**', 'b/**'] },
  })
  expect(excludeEntry('analyzers.assets', 'optimizeIgnore', 'a/**', repo, own).value).toEqual({
    optimizeTop: 5,
    optimizeIgnore: ['a/**'],
  })
})

test('starts a repository entry from a broader winning value', () => {
  const group = entry({ groups: ['games'] }, { budgets: [], ignore: ['vendor/**'] })
  expect(excludeEntry('analyzers.assets', 'ignore', 'tmp/**', repo, group)).toEqual({
    key: 'analyzers.assets',
    scope: { repos: ['work:games/app'] },
    value: { budgets: [], ignore: ['vendor/**', 'tmp/**'] },
  })
  expect(excludeEntry('analyzers.assets', 'ignore', 'tmp/**', repo, undefined)).toEqual({
    key: 'analyzers.assets',
    scope: { repos: ['work:games/app'] },
    value: { ignore: ['tmp/**'] },
  })
})
