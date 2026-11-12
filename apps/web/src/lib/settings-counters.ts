import type { AiBudgetStatus, CredentialView } from '@holtkeeper/api'

import { credentialStatus, needsAttention } from './credential-status.ts'

/**
 * The share of the budget covering everything (scope `all`) spent this week, as the AI entry of
 * the Settings sub-navigation shows it (`56%`); `undefined` without such a budget.
 */
export function budgetMeta(budgets: readonly AiBudgetStatus[]): string | undefined {
  const broadest = budgets.find((budget) => budget.scope.all === true)
  return broadest ? `${Math.round(broadest.percent)}%` : undefined
}

/**
 * How many credentials need someone: the last rotation or test failed, or the secret expires
 * within 14 days or already expired.
 */
export const credentialsNeedingAttention = (
  credentials: readonly CredentialView[],
  now: Date,
): number =>
  credentials.filter((credential) => needsAttention(credentialStatus(credential, now))).length

/**
 * A release as people read it: a full commit hash cut to 7 characters, a bare version number
 * `v`-prefixed (`1.2.3` → `v1.2.3`), anything else (`v1.2.3`, `nightly`) as given.
 */
export const formatRelease = (version: string): string =>
  /^[0-9a-f]{40}$/.test(version)
    ? version.slice(0, 7)
    : /^\d/.test(version)
      ? `v${version}`
      : version

/**
 * The Settings footer's instance line: the host of `publicUrl` (else `origin`) and the release
 * (`formatRelease`).
 */
export function instanceLine(
  me: { version?: string; publicUrl?: string },
  origin: string,
): string | undefined {
  const host = hostOf(me.publicUrl) ?? hostOf(origin)
  const version = me.version ? formatRelease(me.version) : undefined
  const parts = [host, version].filter((part) => part !== undefined)
  return parts.length ? parts.join(' · ') : undefined
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    return new URL(url).host || undefined
  } catch {
    return undefined
  }
}
