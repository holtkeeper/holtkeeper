import { describe, expect, test } from 'bun:test'

import type { CredentialView, LimitUsageRow } from '@holtkeeper/api'

import {
  credentialGroup,
  credentialStatus,
  lastUsedLabel,
  limitStatus,
  limitUsageViews,
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

const usage = (overrides: Partial<LimitUsageRow> = {}): LimitUsageRow => ({
  key: 'c1',
  credentialId: 'c1',
  name: 'widget-bot',
  kind: 'gitlab',
  policy: { maxConcurrent: 8, requestsPerMinute: 300 },
  source: 'default',
  requestsLastHour: 412,
  tokensLastHour: 0,
  inFlight: 3,
  dayTokens: 0,
  dayCostUsd: 0,
  ...overrides,
})

describe('limitUsageViews', () => {
  test('converts per-minute policies to hourly limits with clear units', () => {
    const [row] = limitUsageViews([usage()], now)
    expect(row).toEqual({
      key: 'c1',
      name: 'widget-bot',
      kind: 'gitlab',
      missing: false,
      limit: '18,000 requests / hour',
      limitDetail: '300 per minute · kind default',
      meter: { unit: 'requests', used: 412, max: 18_000, share: 412 / 18_000 },
      used: '412 · 2%',
      atOnce: '3 / 8',
      daily: '—',
      status: { state: 'within', label: 'Within limit', tone: 'success' },
    })
  })

  test('AI keys show tokens per hour and their daily caps', () => {
    const [row] = limitUsageViews(
      [
        usage({
          kind: 'anthropic',
          source: 'configured',
          policy: {
            maxConcurrent: 3,
            tokensPerMinute: 40_000,
            tokensPerDay: 1_000_000,
            costPerDayUsd: 150,
          },
          requestsLastHour: 0,
          tokensLastHour: 1_200_000,
          dayTokens: 300_000,
          dayCostUsd: 12.5,
          inFlight: 0,
        }),
      ],
      now,
    )
    expect(row).toMatchObject({
      limit: '2,400,000 tokens / hour',
      limitDetail: '40,000 tokens per minute · set here',
      used: '1,200,000 · 50%',
      atOnce: '0 / 3',
      daily: '300,000 of 1,000,000 tokens · $12.50 of $150',
    })
  })

  test('without limits the counts stay readable', () => {
    const [row] = limitUsageViews([usage({ policy: {}, requestsLastHour: 7 })], now)
    expect(row).toMatchObject({
      limit: 'No rate limit',
      used: '7 requests',
      atOnce: '3',
      status: { state: 'unlimited', label: 'No limit' },
    })
    expect(row?.meter).toBeUndefined()
  })

  test('sorts the most urgent first and unknown keys last', () => {
    const rows = limitUsageViews(
      [
        usage({ key: 'a', name: 'alpha' }),
        usage({ key: 'ghost', name: 'ghost', missing: true, policy: { requestsPerMinute: 1 } }),
        usage({ key: 'b', name: 'beta', requestsLastHour: 17_000 }),
      ],
      now,
    )
    expect(rows.map((row) => row.key)).toEqual(['b', 'a', 'ghost'])
  })
})

describe('limitStatus', () => {
  test('a used-up daily cap wins', () => {
    expect(
      limitStatus(
        usage({
          policy: { costPerDayUsd: 10 },
          dayCostUsd: 10,
          coolDownUntil: '2026-11-12T12:05:00.000Z',
        }),
        now,
      ),
    ).toMatchObject({ state: 'capped', label: 'Daily cap reached', tone: 'danger' })
  })

  test('an active cool-down names when it ends', () => {
    const until = '2026-11-12T12:05:00.000Z'
    const time = new Date(until).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })
    expect(limitStatus(usage({ coolDownUntil: until }), now)).toMatchObject({
      state: 'cooling',
      label: `Cooling down until ${time}`,
      tone: 'warning',
    })
    expect(limitStatus(usage({ coolDownUntil: '2026-11-12T11:59:00.000Z' }), now).state).toBe(
      'within',
    )
  })

  test('near the limit from 90% of an hourly or daily limit', () => {
    expect(limitStatus(usage({ requestsLastHour: 16_200 }), now)).toMatchObject({
      state: 'near',
      label: 'Near limit',
      why: '90% of the hourly requests limit used',
    })
    expect(limitStatus(usage({ requestsLastHour: 16_199 }), now).state).toBe('within')
    expect(
      limitStatus(usage({ policy: { tokensPerDay: 1000 }, dayTokens: 950 }), now),
    ).toMatchObject({ state: 'near', why: '95% of the daily cap used' })
  })

  test('a rate-limit answer within the last hour reads as near the limit', () => {
    expect(limitStatus(usage({ last429At: '2026-11-12T11:40:00.000Z' }), now)).toMatchObject({
      state: 'near',
      why: 'Rate limited 20 minutes ago',
    })
    expect(limitStatus(usage({ last429At: '2026-11-12T10:30:00.000Z' }), now).state).toBe('within')
  })
})
