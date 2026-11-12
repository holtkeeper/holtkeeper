import { expect, test } from 'bun:test'

import type { AiBudgetStatus, CredentialView } from '@holtkeeper/api'

import {
  budgetMeta,
  credentialsNeedingAttention,
  formatRelease,
  instanceLine,
} from './settings-counters.ts'

const now = new Date('2026-11-12T12:00:00.000Z')

const budget = (scope: AiBudgetStatus['scope'], percent: number) =>
  ({ id: 'b', scope, percent }) as AiBudgetStatus

const credential = (overrides: Partial<CredentialView>): CredentialView => ({
  id: 'c',
  name: 'Widget bot',
  kind: 'gitlab',
  url: 'https://gitlab.acme.test',
  scope: { all: true },
  rotatable: true,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...overrides,
})

test('the AI entry shows the share of the budget over everything', () => {
  expect(budgetMeta([budget({ groups: ['shapes'] }, 90), budget({ all: true }, 55.6)])).toBe('56%')
  expect(budgetMeta([budget({ groups: ['shapes'] }, 90)])).toBeUndefined()
})

test('credentials with errors, failed probes or a near expiry need attention', () => {
  expect(
    credentialsNeedingAttention(
      [
        credential({}),
        credential({ lastError: 'rotation failed' }),
        credential({ expiresAt: '2026-11-20T00:00:00.000Z' }),
        credential({ expiresAt: '2027-01-20T00:00:00.000Z' }),
        credential({
          capabilities: { agentLoop: 'failed', checkedAt: '2026-11-01T00:00:00.000Z' },
        }),
      ],
      now,
    ),
  ).toBe(3)
})

test('the footer names the host and the release', () => {
  expect(
    instanceLine({ version: '0.42.1', publicUrl: 'https://holtkeeper.acme.test/' }, 'http://x'),
  ).toBe('holtkeeper.acme.test · v0.42.1')
  expect(instanceLine({ version: 'a'.repeat(40) }, 'http://localhost:7420')).toBe(
    'localhost:7420 · aaaaaaa',
  )
  expect(instanceLine({ version: 'nightly' }, 'not a url')).toBe('nightly')
  expect(instanceLine({}, '')).toBeUndefined()
})

test('formatRelease shortens hashes and prefixes bare versions only', () => {
  expect(formatRelease('1.4.0')).toBe('v1.4.0')
  expect(formatRelease('v1.4.0')).toBe('v1.4.0')
  expect(formatRelease('3f9c'.repeat(10))).toBe('3f9c3f9')
})
