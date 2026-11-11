import { expect, test } from 'bun:test'

import type { CoverageData } from './model.ts'
import {
  ROOT_GROUP,
  changedFilesCoverage,
  coverageChanges,
  coverageGroupOf,
  coverageGroups,
  coverageTotals,
  worstFiles,
} from './summary.ts'

const data: CoverageData = {
  tools: ['vitest --coverage'],
  languages: ['js'],
  summary: { lines: { covered: 60, total: 100 }, branches: { covered: 4, total: 10 } },
  files: [
    { file: 'packages/widget/src/a.ts', lines: { covered: 30, total: 40 } },
    {
      file: 'packages/widget/src/b.ts',
      lines: { covered: 10, total: 10 },
      branches: { covered: 4, total: 10 },
    },
    { file: 'apps/shop/src/main.ts', lines: { covered: 0, total: 30 }, loaded: false },
    { file: 'src/util.ts', lines: { covered: 20, total: 20 } },
    { file: 'setup.ts', lines: { covered: 0, total: 0 } },
  ],
}

test('totals count files without tests and their lines', () => {
  expect(coverageTotals(data)).toEqual({
    lines: { covered: 60, total: 100 },
    branches: { covered: 4, total: 10 },
    files: 5,
    untested: 1,
    untestedLines: 30,
  })
})

test('groups files by workspace package or top-level folder', () => {
  expect(coverageGroupOf('packages/widget/src/a.ts')).toBe('packages/widget')
  expect(coverageGroupOf('packages/readme.md')).toBe('packages')
  expect(coverageGroupOf('src/deep/file.ts')).toBe('src')
  expect(coverageGroupOf('setup.ts')).toBe(ROOT_GROUP)
  expect(
    coverageGroups(data.files).map((group) => [group.path, group.lines, group.untested]),
  ).toEqual([
    ['apps/shop', { covered: 0, total: 30 }, 1],
    ['packages/widget', { covered: 40, total: 50 }, 0],
    [ROOT_GROUP, { covered: 0, total: 0 }, 0],
    ['src', { covered: 20, total: 20 }, 0],
  ])
  expect(coverageGroups(data.files)[1]?.branches).toEqual({ covered: 4, total: 10 })
})

test('worst files rank by uncovered lines and skip fully covered ones', () => {
  expect(worstFiles(data.files).map((file) => file.file)).toEqual([
    'apps/shop/src/main.ts',
    'packages/widget/src/a.ts',
  ])
  expect(worstFiles(data.files, 1)).toHaveLength(1)
})

test('changes list files that moved by the threshold, new files from zero', () => {
  const previous: CoverageData = {
    ...data,
    files: [
      { file: 'packages/widget/src/a.ts', lines: { covered: 10, total: 40 } },
      { file: 'packages/widget/src/b.ts', lines: { covered: 9, total: 10 } },
      { file: 'apps/shop/src/main.ts', lines: { covered: 0, total: 30 }, loaded: false },
    ],
  }
  expect(coverageChanges(data, previous)).toEqual([
    { file: 'src/util.ts', after: 100, delta: 100 },
    { file: 'packages/widget/src/a.ts', before: 25, after: 75, delta: 50 },
    { file: 'packages/widget/src/b.ts', before: 90, after: 100, delta: 10 },
  ])
  expect(coverageChanges(data, previous, 20).map((change) => change.file)).toEqual([
    'src/util.ts',
    'packages/widget/src/a.ts',
  ])
})

test('changed files coverage sums files that are new or whose counts differ', () => {
  const previous: CoverageData = {
    ...data,
    files: [
      { file: 'packages/widget/src/a.ts', lines: { covered: 10, total: 40 } },
      { file: 'packages/widget/src/b.ts', lines: { covered: 10, total: 10 } },
      { file: 'apps/shop/src/main.ts', lines: { covered: 0, total: 30 }, loaded: false },
    ],
  }
  expect(changedFilesCoverage(data, previous)).toEqual({
    files: 3,
    lines: { covered: 60, total: 70 },
  })
  expect(changedFilesCoverage(data, data)).toBeUndefined()
})
