import { describe, expect, test } from 'bun:test'

import { bumpFor } from './bump.ts'

describe('bumpFor', () => {
  test.each([
    ['feat: add the widget list', 'minor'],
    ['feat(shapes): add circles', 'minor'],
    ['Feature: add a toggle', 'minor'],
    ['fix: keep the order', 'patch'],
    ['perf(core): cache lookups', 'patch'],
    ['chore: bump some-lib', 'patch'],
    ['update the readme', 'patch'],
    ['feat!: drop the old widget api', 'major'],
    ['refactor(core)!: rename fooUtil', 'major'],
    ['[ABC-12] feat: add filters', 'minor'],
    ['ABC-12: feat: add filters', 'minor'],
    ['ABC-12 feat(shapes)!: drop squares', 'major'],
    ['ABC-12 fix the counter', 'patch'],
  ] as const)('%s → %s', (title, bump) => {
    expect(bumpFor({ title })).toBe(bump)
  })

  test('a breaking change footer makes any commit major', () => {
    expect(bumpFor({ title: 'fix: rename the option', body: 'BREAKING CHANGE: use size' })).toBe(
      'major',
    )
    expect(bumpFor({ title: 'fix: rename the option', body: 'Refs ABC-3' })).toBe('patch')
  })
})
