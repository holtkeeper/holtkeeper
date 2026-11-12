import { expect, test } from 'bun:test'

import { coverageOptionsSchema } from './analyzer.ts'
import type { CoverageData } from './model.ts'
import { DEFAULT_COVERAGE_TARGET, coverageMetrics, coverageTargetOf } from './report.ts'

const data: CoverageData = {
  tools: ['vitest --coverage'],
  languages: ['js'],
  summary: { lines: { covered: 2, total: 3 }, branches: { covered: 1, total: 4 } },
  files: [
    { file: 'src/widget.ts', lines: { covered: 2, total: 2 } },
    { file: 'src/gadget.ts', lines: { covered: 0, total: 1 }, loaded: false },
  ],
}

test('metrics: line share against the target and the delta to the previous record', () => {
  expect(coverageMetrics(data)).toEqual({
    percent: 66.67,
    branches: 25,
    target: DEFAULT_COVERAGE_TARGET,
    files: 2,
    untested: 1,
    tools: ['vitest --coverage'],
    totals: {
      lines: { covered: 2, total: 3 },
      branches: { covered: 1, total: 4 },
      files: 2,
      untested: 1,
      untestedLines: 1,
    },
  })
  expect(
    coverageMetrics(data, {
      options: { target: '70' },
      previous: { ...coverageMetrics(data), percent: 70.5 },
    }),
  ).toMatchObject({
    target: 70,
    delta: -3.83,
  })
  expect(coverageMetrics(data, { options: { target: 140 } }).target).toBe(DEFAULT_COVERAGE_TARGET)
  const empty = coverageMetrics(
    { ...data, summary: { lines: { covered: 0, total: 0 } }, files: [] },
    {
      previous: { percent: 50, target: 60, files: 1, untested: 0 },
    },
  )
  expect(empty).toMatchObject({ target: 60, files: 0, untested: 0 })
  expect(empty.percent).toBeUndefined()
  expect(empty.delta).toBeUndefined()
  expect(coverageOptionsSchema.parse({}).target).toBe(60)
})

test('coverageTargetOf falls back to the default for missing, null, empty or out-of-range targets', () => {
  expect(coverageTargetOf({ target: 75 })).toBe(75)
  expect(coverageTargetOf({ target: '0' })).toBe(0)
  for (const options of [
    undefined,
    {},
    { target: null },
    { target: '' },
    { target: 'x' },
    { target: -1 },
  ])
    expect(coverageTargetOf(options)).toBe(DEFAULT_COVERAGE_TARGET)
})
