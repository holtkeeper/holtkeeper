import { describe, expect, test } from 'bun:test'

import { goFilePath, parseGoCoverFunc, parseGoCoverProfile, withGoFunctions } from './gocover.ts'

// `go test ./... -coverprofile=cover.out` (Go 1.25) on a module with one tested function.
const PROFILE = `mode: set
example.com/shop/calc/calc.go:4.2,5.1 1 1
example.com/shop/calc/calc.go:8.2,8.24 1 0
example.com/shop/calc/calc.go:9.3,10.1 1 0
example.com/shop/calc/calc.go:11.2,11.14 1 0
`

const FUNC = `example.com/shop/calc/calc.go:3:	Add		100.0%
example.com/shop/calc/calc.go:7:	Discount	0.0%
total:					(statements)	25.0%
`

const modules = [{ path: 'example.com/shop', dir: '' }]

describe('Go coverage', () => {
  test('maps import paths to project paths', () => {
    expect(goFilePath('example.com/shop/calc/calc.go', modules)).toBe('calc/calc.go')
    expect(
      goFilePath('example.com/shop/api/x.go', [
        { path: 'example.com/shop/api', dir: 'api' },
        ...modules,
      ]),
    ).toBe('api/x.go')
    expect(goFilePath('other.org/x.go', modules)).toBe('other.org/x.go')
  })

  test('parses a cover profile into lines and a statement summary', () => {
    const report = parseGoCoverProfile(PROFILE, modules)
    expect(report.format).toBe('go')
    expect(report.languages).toEqual(['go'])
    expect(report.files).toEqual([
      {
        file: 'calc/calc.go',
        lines: [
          { line: 4, hits: 1 },
          { line: 5, hits: 1 },
          { line: 8, hits: 0 },
          { line: 9, hits: 0 },
          { line: 10, hits: 0 },
          { line: 11, hits: 0 },
        ],
        functions: [],
        branches: [],
      },
    ])
    expect(report.summary).toEqual({ lines: { covered: 1, total: 4 } })
  })

  test('keeps the highest count for lines shared by blocks', () => {
    const report = parseGoCoverProfile('mode: count\nm/a.go:1.1,3.2 2 0\nm/a.go:3.3,4.1 1 5\n', [
      { path: 'm', dir: '' },
    ])
    expect(report.files[0]?.lines.find((line) => line.line === 3)?.hits).toBe(5)
  })

  test('adds function names from go tool cover -func', () => {
    const functions = parseGoCoverFunc(FUNC, modules)
    expect(functions.get('calc/calc.go')).toEqual([
      { name: 'Add', line: 3, hits: 1 },
      { name: 'Discount', line: 7, hits: 0 },
    ])
    const report = withGoFunctions(parseGoCoverProfile(PROFILE, modules), functions)
    expect(report.files[0]?.functions).toHaveLength(2)
    expect(report.summary.functions).toEqual({ covered: 1, total: 2 })
  })
})
