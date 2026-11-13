import { describe, expect, test } from 'bun:test'

import { evalGoBuildConstraint, goBuildConstraint, goTaggedTests } from './gotags.ts'

describe('goBuildConstraint', () => {
  test('reads the line above the package clause only', () => {
    expect(goBuildConstraint('// Copyright\n\n//go:build integration\n\npackage gear\n')).toBe(
      'integration',
    )
    expect(goBuildConstraint('/* header\n*/\n//go:build e2e && !short\npackage gear\n')).toBe(
      'e2e && !short',
    )
    expect(goBuildConstraint('package gear\n\n//go:build integration\n')).toBeUndefined()
  })
})

const set =
  (...tags: string[]) =>
  (tag: string) =>
    tags.includes(tag)

test('evalGoBuildConstraint', () => {
  expect(evalGoBuildConstraint('a && (b || !c)', set('a', 'c'))).toBe(false)
  expect(evalGoBuildConstraint('a && (b || !c)', set('a', 'b'))).toBe(true)
  expect(evalGoBuildConstraint('a &&', set('a'))).toBeUndefined()
})

test('goTaggedTests counts test files that need tags the run does not set', () => {
  const files = [
    { file: 'gear/a_test.go', source: '//go:build integration\n\npackage gear\n' },
    { file: 'gear/b_test.go', source: '//go:build integration && linux\n\npackage gear\n' },
    { file: 'gear/c_test.go', source: '//go:build e2e || integration\n\npackage gear\n' },
    { file: 'gear/d_test.go', source: '//go:build !integration\n\npackage gear\n' },
    { file: 'gear/e_test.go', source: '//go:build windows\n\npackage gear\n' },
    { file: 'gear/f_test.go', source: 'package gear\n' },
    { file: 'gear/g.go', source: '//go:build tools\n\npackage gear\n' },
  ]
  expect(goTaggedTests(files)).toEqual({
    files: 3,
    tags: [
      { tag: 'integration', files: 3 },
      { tag: 'e2e', files: 1 },
    ],
  })
  expect(goTaggedTests(files, ['integration'])).toEqual({ files: 0, tags: [] })
})
