import { expect, test } from 'bun:test'

import { combineTypes } from './extract.ts'

test('combineTypes merges two passes that both ran', () => {
  expect(
    combineTypes(
      { status: 'used', projects: ['web'], sites: 2 },
      { status: 'failed', reason: 'go: list failed' },
    ),
  ).toEqual({ status: 'used', reason: 'go: list failed', projects: ['web'], sites: 2 })
  expect(
    combineTypes(
      { status: 'failed', reason: 'tsgo: no answer' },
      { status: 'used', projects: ['example.com/acme/shapes'], sites: 3 },
    ),
  ).toEqual({
    status: 'used',
    reason: 'tsgo: no answer',
    projects: ['example.com/acme/shapes'],
    sites: 3,
  })
  expect(
    combineTypes(
      { status: 'used', projects: ['web'], sites: 1, reason: 'some type errors' },
      { status: 'used', projects: ['example.com/acme/shapes'], sites: 4 },
    ),
  ).toEqual({
    status: 'used',
    reason: 'some type errors',
    projects: ['web', 'example.com/acme/shapes'],
    sites: 5,
  })
  expect(
    combineTypes({ status: 'failed', reason: 'tsgo: x' }, { status: 'failed', reason: 'go: y' }),
  ).toEqual({ status: 'failed', reason: 'tsgo: x; go: y' })
})

test('combineTypes lets a skipped pass give way to the other', () => {
  const used = { status: 'used' as const, projects: ['web'], sites: 2 }
  expect(combineTypes(used, { status: 'skipped', reason: 'go: no command runner' })).toEqual(used)
  expect(combineTypes({ status: 'skipped', reason: 'no tsconfig.json' }, used)).toEqual(used)
  expect(combineTypes(undefined, used)).toEqual(used)
  expect(combineTypes().status).toBe('skipped')
})
