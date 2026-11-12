import type { McpTokenView } from '@holtkeeper/api'

/** Where a token stands, computed from its dates on the client. */
export type TokenStatus = 'active' | 'expiring' | 'expired' | 'unused'

const soonMs = 14 * 86_400_000

/**
 * `expired` once `expiresAt` passed, `expiring` within 14 days of it, `unused` while it never
 * made a call, otherwise `active`.
 */
export function tokenStatus(
  token: Pick<McpTokenView, 'expiresAt' | 'lastUsedAt'>,
  now: Date = new Date(),
): TokenStatus {
  const left = token.expiresAt ? new Date(token.expiresAt).getTime() - now.getTime() : Infinity
  if (left <= 0) return 'expired'
  if (left <= soonMs) return 'expiring'
  return token.lastUsedAt ? 'active' : 'unused'
}

/** Label and tone of each status, as the tokens table shows them. */
export const tokenStatusLabels: Readonly<
  Record<TokenStatus, { label: string; tone: 'success' | 'warning' | 'danger' | 'default' }>
> = {
  active: { label: 'Active', tone: 'success' },
  expiring: { label: 'Expires soon', tone: 'warning' },
  expired: { label: 'Expired', tone: 'danger' },
  unused: { label: 'Never used', tone: 'default' },
}

/** How many tokens are in each status. */
export function tokenStatusCounts(
  tokens: readonly Pick<McpTokenView, 'expiresAt' | 'lastUsedAt'>[],
  now: Date = new Date(),
): Record<TokenStatus, number> {
  const counts: Record<TokenStatus, number> = { active: 0, expiring: 0, expired: 0, unused: 0 }
  for (const token of tokens) counts[tokenStatus(token, now)] += 1
  return counts
}
