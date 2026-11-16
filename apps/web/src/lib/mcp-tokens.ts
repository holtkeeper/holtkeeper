import type { McpTokenView, McpToolsetInfo, McpToolsetName } from '@holtkeeper/api'

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

/**
 * How the tokens table names the toolsets a token serves: `Default tools` while they are the
 * catalog defaults, `All tools`, `No tools`, or `N of M tools`.
 */
export function toolsetsLabel(
  toolsets: readonly McpToolsetName[],
  catalog: readonly McpToolsetInfo[],
): string {
  const on = catalog.filter((toolset) => toolsets.includes(toolset.name))
  if (catalog.every((toolset) => toolset.defaultOn === toolsets.includes(toolset.name)))
    return 'Default tools'
  if (on.length === catalog.length) return 'All tools'
  if (!on.length) return 'No tools'
  return `${on.length} of ${catalog.length} tools`
}

/** `toolsets` with `name` turned on or off, in catalog order. */
export function toggleToolset(
  toolsets: readonly McpToolsetName[],
  name: McpToolsetName,
  on: boolean,
  catalog: readonly McpToolsetInfo[],
): McpToolsetName[] {
  return catalog
    .map((toolset) => toolset.name)
    .filter((each) => (each === name ? on : toolsets.includes(each)))
}
