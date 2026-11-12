import { describe, expect, test } from 'bun:test'

import { tokenStatus, tokenStatusCounts } from './mcp-tokens.ts'

const now = new Date('2026-11-11T12:00:00Z')

describe('mcp token status', () => {
  test('expiry wins over use, then use decides', () => {
    expect(
      tokenStatus({ expiresAt: '2026-11-10T00:00:00Z', lastUsedAt: '2026-11-09T00:00:00Z' }, now),
    ).toBe('expired')
    expect(
      tokenStatus({ expiresAt: '2026-11-20T00:00:00Z', lastUsedAt: '2026-11-09T00:00:00Z' }, now),
    ).toBe('expiring')
    expect(tokenStatus({ expiresAt: '2027-02-01T00:00:00Z' }, now)).toBe('unused')
    expect(tokenStatus({ lastUsedAt: '2026-11-11T08:00:00Z' }, now)).toBe('active')
    expect(tokenStatus({}, now)).toBe('unused')
  })

  test('counts tokens per status', () => {
    expect(
      tokenStatusCounts(
        [
          { lastUsedAt: '2026-11-11T08:00:00Z' },
          { lastUsedAt: '2026-11-01T08:00:00Z' },
          { expiresAt: '2026-11-01T00:00:00Z' },
          {},
        ],
        now,
      ),
    ).toEqual({ active: 2, expiring: 0, expired: 1, unused: 1 })
  })
})
