import { expect, test } from 'bun:test'

import type { SettingView } from '@holtkeeper/api'

import {
  type PolicyFocus,
  allowlistRowProblem,
  allowlistRows,
  draftChanges,
  draftCount,
  draftValue,
  focusEntry,
  listOf,
  withEdit,
  withReset,
} from './policy-draft.ts'

const entry = (id: string, key: string, scope: SettingView['scope'], value: unknown) => ({
  id,
  key,
  scope,
  value,
  secret: false,
  updatedAt: '2026-11-01T00:00:00.000Z',
})

const entries: SettingView[] = [
  entry('lic-org', 'analyzers.licenses', { all: true }, { allow: ['MIT'] }),
  entry('lic-web', 'analyzers.licenses', { groups: ['web'] }, { allow: ['MIT', 'ISC'] }),
  entry('lic-shared', 'analyzers.licenses', { groups: ['web', 'pay'] }, { allow: [] }),
  entry('fix-org', 'audit.fix', { all: true }, true),
]

const org: PolicyFocus = { kind: 'org' }
const web: PolicyFocus = { kind: 'group', group: 'web' }
const pay: PolicyFocus = { kind: 'group', group: 'pay' }

test('the focus reads its own entry, else the organization, else the fallback', () => {
  expect(focusEntry(entries, 'analyzers.licenses', web)?.id).toBe('lic-web')
  expect(focusEntry(entries, 'analyzers.licenses', pay)).toBeUndefined()
  expect(draftValue(entries, {}, 'analyzers.licenses', web, {})).toEqual({
    value: { allow: ['MIT', 'ISC'] },
    inherited: false,
    edited: false,
  })
  expect(draftValue(entries, {}, 'analyzers.licenses', pay, {})).toEqual({
    value: { allow: ['MIT'] },
    inherited: true,
    edited: false,
  })
  expect(draftValue(entries, {}, 'audit.upgrade', org, 'major')).toEqual({
    value: 'major',
    inherited: true,
    edited: false,
  })
})

test('edits, resets and the changes they save at the focus', () => {
  let draft = withEdit(entries, {}, 'analyzers.licenses', web, { allow: ['MIT', 'ISC', '0BSD'] })
  draft = withEdit(entries, draft, 'audit.fix', pay, false)
  draft = withReset(entries, draft, 'analyzers.licenses', web)
  expect(draftCount(draft)).toBe(2)
  expect(draftValue(entries, draft, 'analyzers.licenses', web, {}).value).toEqual({
    allow: ['MIT'],
  })
  expect(draftChanges(entries, draft, web)).toEqual([
    { op: 'put', key: 'audit.fix', scope: { groups: ['web'] }, value: false },
    { op: 'remove', id: 'lic-web' },
  ])
  expect(withEdit(entries, { 'audit.fix': false }, 'audit.fix', org, true)).toEqual({})
  expect(withReset(entries, {}, 'analyzers.licenses', pay)).toEqual({})
  expect(draftChanges(entries, { 'analyzers.licenses': { allow: [] } }, org)).toEqual([
    {
      op: 'put',
      id: 'lic-org',
      key: 'analyzers.licenses',
      scope: { all: true },
      value: { allow: [] },
    },
  ])
})

test('allowlist rows and the rules checked before saving', () => {
  expect(
    allowlistRows([
      { id: 'GHSA-1', reason: 'Not reachable.', expires: '2026-12-01' },
      { id: 'GHSA-2' },
      'junk',
    ]),
  ).toEqual([{ id: 'GHSA-1', reason: 'Not reachable.', expires: '2026-12-01' }])
  const today = '2026-11-12'
  expect(allowlistRowProblem({ requireReason: true }, { reason: ' ' }, today)).toBe('Give a reason')
  expect(allowlistRowProblem({ requireReason: false }, { reason: '' }, today)).toBeUndefined()
  expect(allowlistRowProblem({ maxDays: 30 }, { reason: 'x' }, today)).toBe(
    'Set an expiry within 30 days',
  )
  expect(allowlistRowProblem({ maxDays: 30 }, { reason: 'x', expires: '2026-12-13' }, today)).toBe(
    'Expires after 2026-12-12, past the 30-day limit',
  )
  expect(
    allowlistRowProblem({ maxDays: 30 }, { reason: 'x', expires: '2026-12-12' }, today),
  ).toBeUndefined()
  expect(listOf({ allow: ['MIT', 3] }, 'allow')).toEqual(['MIT'])
  expect(listOf(undefined, 'allow')).toEqual([])
})
