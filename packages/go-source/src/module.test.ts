import { expect, test } from 'bun:test'

import {
  compareGoVersions,
  escapeModulePath,
  isPseudoVersion,
  isStableGoVersion,
  libraryOfModule,
  modulePathOf,
} from './module.ts'

test('libraryOfModule strips the major suffix', () => {
  expect(libraryOfModule('example.com/acme/gears/v2')).toBe('example.com/acme/gears')
  expect(libraryOfModule('example.com/acme/gears/v12')).toBe('example.com/acme/gears')
  expect(libraryOfModule('example.com/acme/gears/v1')).toBe('example.com/acme/gears/v1')
  expect(libraryOfModule('example.com/acme/gears')).toBe('example.com/acme/gears')
})

test('modulePathOf adds the major suffix from v2 up', () => {
  expect(modulePathOf('example.com/acme/gears', 'v2.3.0')).toBe('example.com/acme/gears/v2')
  expect(modulePathOf('example.com/acme/gears', 'v1.3.0')).toBe('example.com/acme/gears')
  expect(modulePathOf('example.com/acme/gears', 'v3.0.0+incompatible')).toBe(
    'example.com/acme/gears',
  )
})

test('version helpers', () => {
  expect(isPseudoVersion('v0.0.0-20240101000000-abcdef123456')).toBe(true)
  expect(isPseudoVersion('v1.2.3')).toBe(false)
  expect(isStableGoVersion('v1.2.3')).toBe(true)
  expect(isStableGoVersion('v1.2.3-rc.1')).toBe(false)
  expect(['v1.10.0', 'v1.2.0', 'v1.2.0-rc.1'].toSorted(compareGoVersions)).toEqual([
    'v1.2.0-rc.1',
    'v1.2.0',
    'v1.10.0',
  ])
  expect(escapeModulePath('example.com/Acme/Gears')).toBe('example.com/!acme/!gears')
})
