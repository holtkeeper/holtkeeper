import { describe, expect, test } from 'bun:test'

import { parseLcov } from './lcov.ts'

// `bun test --coverage --coverage-reporter=lcov` (Bun 1.4): no FN records, counts only.
const BUN = `TN:
SF:src/a.ts
FNF:2
FNH:1
DA:1,1
DA:2,1
DA:5,1
DA:6,0
DA:7,0
LF:5
LH:3
end_of_record
`

// istanbul (vitest/jest/c8): absolute paths, FN/FNDA/BRDA.
const ISTANBUL = `TN:
SF:/work/app/src/session.ts
FN:3,createSession
FN:12,(anonymous_1)
FNF:2
FNH:1
FNDA:4,createSession
FNDA:0,(anonymous_1)
DA:3,4
DA:4,4
DA:5,0
DA:12,0
DA:13,0
LF:5
LH:2
BRDA:4,0,0,4
BRDA:4,0,1,0
BRDA:13,1,0,-
BRDA:13,1,1,-
BRF:4
BRH:1
end_of_record
TN:
SF:/elsewhere/lib.js
DA:1,1
end_of_record
`

// lcov 2 writes the end line in FN.
const LCOV2 = `SF:pkg/mod.py
FN:2,9,parse,line
FNDA:0,parse,line
DA:2,0
DA:3,0
end_of_record
`

describe('parseLcov', () => {
  test('parses Bun output', () => {
    const report = parseLcov(BUN)
    expect(report.format).toBe('lcov')
    expect(report.languages).toEqual(['js'])
    expect(report.files).toEqual([
      {
        file: 'src/a.ts',
        lines: [
          { line: 1, hits: 1 },
          { line: 2, hits: 1 },
          { line: 5, hits: 1 },
          { line: 6, hits: 0 },
          { line: 7, hits: 0 },
        ],
        functions: [],
        branches: [],
      },
    ])
    expect(report.summary).toEqual({
      lines: { covered: 3, total: 5 },
      functions: { covered: 1, total: 2 },
    })
  })

  test('parses istanbul output with functions and branches, relative to dir', () => {
    const report = parseLcov(ISTANBUL, '/work/app')
    const [session, outside] = report.files
    expect(session?.file).toBe('src/session.ts')
    expect(outside?.file).toBe('/elsewhere/lib.js')
    expect(session?.functions).toEqual([
      { name: 'createSession', line: 3, hits: 4 },
      { name: '(anonymous_1)', line: 12, hits: 0 },
    ])
    expect(session?.branches).toEqual([
      { line: 4, block: '0', branch: '0', taken: 4 },
      { line: 4, block: '0', branch: '1', taken: 0 },
      { line: 13, block: '1', branch: '0' },
      { line: 13, block: '1', branch: '1' },
    ])
    expect(report.summary).toEqual({
      lines: { covered: 3, total: 6 },
      functions: { covered: 1, total: 2 },
    })
  })

  test('reads lcov 2 function end lines and names with commas', () => {
    const report = parseLcov(LCOV2)
    expect(report.languages).toEqual(['python'])
    expect(report.files[0]?.functions).toEqual([
      { name: 'parse,line', line: 2, endLine: 9, hits: 0 },
    ])
  })

  test('ignores garbage', () => {
    expect(parseLcov('hello\nDA:1,1\n').files).toEqual([])
  })
})
