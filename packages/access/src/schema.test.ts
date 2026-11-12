import { expect, test } from 'bun:test'

import { grantSchema } from './schema.ts'

test('grants name only actions the model knows', () => {
  expect(grantSchema.safeParse({ scope: { all: true }, actions: ['audits:run'] }).success).toBe(
    true,
  )
  expect(
    grantSchema.safeParse({ scope: { all: true }, actions: ['audits:allowlist'] }).success,
  ).toBe(false)
})
