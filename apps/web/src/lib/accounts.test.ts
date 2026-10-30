import { describe, expect, test } from 'bun:test'

import type { ExternalAccountView } from '@holtkeeper/api'

import {
  challengePending,
  forgeProviders,
  numericIdProvider,
  providerLabel,
  toLinkInput,
  validateLinkDraft,
  verificationLabel,
} from './accounts.ts'

test('providerLabel', () => {
  expect(providerLabel('gitlab:work')).toBe('GitLab · work')
  expect(providerLabel('slack:T123')).toBe('Slack · T123')
  expect(providerLabel('matrix')).toBe('Matrix')
})

test('numericIdProvider', () => {
  expect(numericIdProvider('gitlab:work')).toBe(true)
  expect(numericIdProvider('github:gh')).toBe(true)
  expect(numericIdProvider('slack:T1')).toBe(false)
})

test('forgeProviders keeps GitLab and GitHub forges', () => {
  expect(
    forgeProviders([
      { id: 'work', kind: 'gitlab' },
      { id: 'local', kind: 'fs' },
    ]),
  ).toEqual([{ id: 'gitlab:work', label: 'GitLab · work' }])
})

test('verificationLabel', () => {
  expect(verificationLabel('challenge').tone).toBe('success')
  expect(verificationLabel('admin').text).toBe('Verified by admin')
  expect(verificationLabel('unverified').tone).toBe('warning')
})

describe('challengePending', () => {
  const account: ExternalAccountView = {
    id: 'a1',
    userId: 'u1',
    provider: 'gitlab:work',
    externalId: '42',
    verification: 'unverified',
    linkedBy: 'u1',
    linkedAt: '2026-10-30T10:00:00Z',
    challengeExpiresAt: '2026-10-30T10:30:00Z',
  }
  const now = new Date('2026-10-30T10:10:00Z')

  test('until it expires', () => {
    expect(challengePending(account, now)).toBe(true)
    expect(challengePending(account, new Date('2026-10-30T11:00:00Z'))).toBe(false)
  })

  test('never once verified', () => {
    expect(challengePending({ ...account, verification: 'challenge' }, now)).toBe(false)
  })
})

describe('validateLinkDraft', () => {
  test('GitLab ids are numeric', () => {
    expect(
      validateLinkDraft({ provider: 'gitlab:work', externalId: 'jane', username: '' }).externalId,
    ).toBeDefined()
    expect(validateLinkDraft({ provider: 'gitlab:work', externalId: '42', username: '' })).toEqual(
      {},
    )
  })

  test('Slack ids may be anything', () => {
    expect(validateLinkDraft({ provider: 'slack:T1', externalId: 'U0ABC', username: '' })).toEqual(
      {},
    )
  })

  test('provider and id are required', () => {
    const errors = validateLinkDraft({ provider: '', externalId: '', username: '' })
    expect(errors.provider).toBeDefined()
    expect(errors.externalId).toBeDefined()
    expect(
      validateLinkDraft({ provider: 'GitLab work', externalId: '1', username: '' }).provider,
    ).toBeDefined()
  })
})

test('toLinkInput trims and drops an empty username', () => {
  expect(toLinkInput({ provider: ' gitlab:work ', externalId: ' 42 ', username: '' })).toEqual({
    provider: 'gitlab:work',
    externalId: '42',
  })
  expect(toLinkInput({ provider: 'gitlab:work', externalId: '42', username: '@jane' })).toEqual({
    provider: 'gitlab:work',
    externalId: '42',
    username: 'jane',
  })
})
