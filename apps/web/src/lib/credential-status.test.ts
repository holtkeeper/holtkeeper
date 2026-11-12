import { describe, expect, test } from 'bun:test'

import type { CredentialView } from '@holtkeeper/api'

import {
  credentialGroup,
  credentialStatus,
  lastUsedLabel,
  limitRows,
  needsAttention,
  sortCredentials,
  usedByLabel,
} from './credential-status.ts'

const now = new Date('2026-11-12T12:00:00.000Z')

const credential = (overrides: Partial<CredentialView> = {}): CredentialView => ({
  id: 'c1',
  name: 'widget-bot',
  kind: 'gitlab',
  url: 'https://forge.example.test',
  scope: { all: true },
  rotatable: true,
  usedBy: [{ kind: 'forge', id: 'work', label: 'Forge work' }],
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...overrides,
})

describe('credentialStatus', () => {
  test('expired wins over everything else', () => {
    const status = credentialStatus(
      credential({ expiresAt: '2026-11-10T12:00:00.000Z', lastError: 'boom' }),
      now,
    )
    expect(status).toMatchObject({ state: 'expired', label: 'Expired', tone: 'danger' })
    expect(status.why).toBe('Expired 2 days ago')
  })

  test('a failed rotation or tool-use test is failing, with the reason', () => {
    expect(credentialStatus(credential({ lastError: 'token revoked' }), now)).toEqual({
      state: 'failing',
      label: 'Failing',
      tone: 'danger',
      why: 'token revoked',
    })
    const probe = credentialStatus(
      credential({
        kind: 'anthropic',
        capabilities: { agentLoop: 'failed', checkedAt: '2026-11-11T00:00:00.000Z' },
      }),
      now,
    )
    expect(probe).toMatchObject({ state: 'failing', why: 'The last test of tool use failed' })
  })

  test('expiring within 14 days', () => {
    expect(credentialStatus(credential({ expiresAt: '2026-11-15T13:00:00.000Z' }), now)).toEqual({
      state: 'expiring',
      label: 'Expires soon',
      tone: 'warning',
      why: 'Expires in 3 days',
    })
    expect(credentialStatus(credential({ expiresAt: '2026-11-12T20:00:00.000Z' }), now).why).toBe(
      'Expires today',
    )
    expect(credentialStatus(credential({ expiresAt: '2026-12-31T00:00:00.000Z' }), now).state).toBe(
      'healthy',
    )
  })

  test('unused needs nothing referring to it and no use for 30 days', () => {
    expect(credentialStatus(credential({ usedBy: [] }), now)).toMatchObject({
      state: 'unused',
      why: 'Nothing refers to it and nothing used it',
    })
    expect(
      credentialStatus(credential({ usedBy: [], lastUsedAt: '2026-11-11T12:00:00.000Z' }), now)
        .state,
    ).toBe('healthy')
    expect(
      credentialStatus(credential({ usedBy: [], lastUsedAt: '2026-09-01T00:00:00.000Z' }), now).why,
    ).toBe('Nothing refers to it; last used 2 months ago')
    expect(
      credentialStatus(credential({ usedBy: [], createdAt: '2026-11-01T00:00:00.000Z' }), now)
        .state,
    ).toBe('healthy')
    const { usedBy: _, ...unknown } = credential()
    expect(credentialStatus(unknown, now).state).toBe('healthy')
  })

  test('needsAttention covers expired, failing and expiring only', () => {
    const states = [
      credential({ expiresAt: '2026-11-01T00:00:00.000Z' }),
      credential({ lastError: 'x' }),
      credential({ expiresAt: '2026-11-14T00:00:00.000Z' }),
      credential({ usedBy: [] }),
      credential(),
    ].map((item) => needsAttention(credentialStatus(item, now)))
    expect(states).toEqual([true, true, true, false, false])
  })
})

describe('table helpers', () => {
  test('groups kinds', () => {
    expect(
      ['gitlab', 'github', 'ssh', 'egress-secret', 'anthropic', 'jira'].map(credentialGroup),
    ).toEqual(['forge', 'forge', 'forge', 'proxy', 'ai', 'other'])
  })

  test('sorts by status, then expiry, then name', () => {
    const sorted = sortCredentials(
      [
        credential({ name: 'b-healthy' }),
        credential({ name: 'a-healthy' }),
        credential({ name: 'later', expiresAt: '2027-03-01T00:00:00.000Z' }),
        credential({ name: 'sooner', expiresAt: '2027-01-01T00:00:00.000Z' }),
        credential({ name: 'unused', usedBy: [] }),
        credential({ name: 'broken', lastError: 'x' }),
        credential({ name: 'gone', expiresAt: '2026-11-01T00:00:00.000Z' }),
      ],
      now,
    )
    expect(sorted.map((item) => item.name)).toEqual([
      'gone',
      'broken',
      'unused',
      'sooner',
      'later',
      'a-healthy',
      'b-healthy',
    ])
  })

  test('labels last use and what uses it', () => {
    expect(lastUsedLabel(undefined, now)).toBe('Never')
    expect(lastUsedLabel('2026-11-12T11:59:30.000Z', now)).toBe('Within a minute')
    expect(lastUsedLabel('2026-11-12T11:56:00.000Z', now)).toBe('4 minutes ago')
    expect(usedByLabel(undefined)).toBe('—')
    expect(usedByLabel([])).toBe('Nothing')
    expect(
      usedByLabel([
        { kind: 'forge', id: 'work', label: 'Forge work' },
        { kind: 'setting', id: 'libraries', label: 'Library index' },
      ]),
    ).toBe('Forge work +1')
  })
})

describe('limitRows', () => {
  test('lists configured limits with only the fields set', () => {
    const rows = limitRows(
      [
        {
          id: 'l1',
          key: 'limits.credentials',
          secret: false,
          value: {
            c1: { requestsPerMinute: 300, maxConcurrent: 8 },
            'gadget-key': { costPerDayUsd: 20, backoff: { onStatus: [429], baseMs: 1, maxMs: 2 } },
            unknown: {},
          },
        },
        { id: 'x', key: 'trackers', secret: false, value: {} },
      ],
      [
        { id: 'c1', name: 'widget-bot', kind: 'gitlab' },
        { id: 'c2', name: 'gadget-key', kind: 'anthropic' },
      ],
    )
    expect(rows).toEqual([
      {
        settingId: 'l1',
        key: 'c1',
        credential: { id: 'c1', name: 'widget-bot', kind: 'gitlab' },
        limit: '300 requests/min · 8 at once',
      },
      {
        settingId: 'l1',
        key: 'gadget-key',
        credential: { id: 'c2', name: 'gadget-key', kind: 'anthropic' },
        limit: '$20/day · custom backoff',
      },
      { settingId: 'l1', key: 'unknown', limit: 'Kind defaults' },
    ])
  })
})
