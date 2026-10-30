import { expect, test } from 'bun:test'

import type { FixAttempt } from '@holtkeeper/api'

import { fixChains } from './fixes.ts'

const attempt = (
  fixer: string,
  source: string,
  requested: string[],
  fixed: string[],
  error?: string,
): FixAttempt => ({
  fixer,
  source,
  requested,
  fixed,
  changedFiles: [],
  notes: [],
  ...(error ? { error } : {}),
})

test('groups attempts per source in order', () => {
  const chains = fixChains([
    attempt('pnpm-update', 'pnpm-lock.yaml', ['a', 'b', 'c'], ['a']),
    attempt('go-get', 'go.mod', ['x'], [], 'boom'),
    attempt('pnpm-override', 'pnpm-lock.yaml', ['b', 'c'], ['b']),
  ])
  expect(
    chains.map((c) => [c.source, c.attempts.map((a) => a.fixer), c.requested, c.fixed, c.failed]),
  ).toEqual([
    ['pnpm-lock.yaml', ['pnpm-update', 'pnpm-override'], 3, 2, false],
    ['go.mod', ['go-get'], 1, 0, true],
  ])
})
