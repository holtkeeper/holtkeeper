import { expect, test } from 'bun:test'

import { roleOf } from './roles.ts'

test('admin needs * on every repository; read-only grants are viewers', () => {
  expect(roleOf([])).toBe('none')
  expect(roleOf([{ scope: { all: true }, actions: ['*'] }])).toBe('admin')
  expect(roleOf([{ scope: { groups: ['widgets'] }, actions: ['*'] }])).toBe('custom')
  expect(
    roleOf([
      { scope: { groups: ['widgets'] }, actions: ['repos:read', 'analyses:read'] },
      { scope: { all: true }, actions: ['audit:read'] },
    ]),
  ).toBe('viewer')
  expect(roleOf([{ scope: { groups: ['widgets'] }, actions: ['repos:read', 'audits:run'] }])).toBe(
    'custom',
  )
})
