import type { CredentialView } from '@holtkeeper/api'

import { daysUntil, formatRelative } from './format.ts'

const DAY_MS = 86_400_000

/** Days before expiry from which a credential needs attention. */
const EXPIRING_DAYS = 14

/** Days without a use after which a credential nothing refers to reads as unused. */
const UNUSED_DAYS = 30

/** Credential kinds that are AI providers; their keys live in Settings › AI. */
export const aiCredentialKinds: readonly string[] = ['anthropic', 'anthropic-compatible', 'ai-sdk']

/** Where a credential sits in the Integrations table, from its kind. */
export type CredentialGroup = 'forge' | 'proxy' | 'ai' | 'other'

/** The table group of a credential `kind`. */
export function credentialGroup(kind: string): CredentialGroup {
  if (kind === 'gitlab' || kind === 'github' || kind === 'ssh') return 'forge'
  if (kind === 'egress-secret') return 'proxy'
  if (aiCredentialKinds.includes(kind)) return 'ai'
  return 'other'
}

/** What a credential needs, most urgent first. */
type CredentialState = 'expired' | 'failing' | 'expiring' | 'unused' | 'healthy'

/** A credential's state in words with the tone that says the same, and why when it is not fine. */
export interface CredentialStatus {
  state: CredentialState
  label: string
  tone: 'danger' | 'warning' | 'default' | 'success'
  why?: string
}

type StatusFields = Pick<
  CredentialView,
  'expiresAt' | 'lastError' | 'capabilities' | 'usedBy' | 'lastUsedAt' | 'createdAt'
>

/**
 * Where a credential stands: expired, its last rotation or test failed, it expires within 14
 * days, nothing refers to it and nothing used it in 30 days (counted from its creation when it was
 * never used), or healthy.
 */
export function credentialStatus(credential: StatusFields, now: Date): CredentialStatus {
  if (credential.expiresAt !== undefined && Date.parse(credential.expiresAt) <= now.getTime())
    return {
      state: 'expired',
      label: 'Expired',
      tone: 'danger',
      why: `Expired ${formatRelative(credential.expiresAt, now)}`,
    }
  if (credential.lastError !== undefined)
    return { state: 'failing', label: 'Failing', tone: 'danger', why: credential.lastError }
  if (credential.capabilities?.agentLoop === 'failed')
    return {
      state: 'failing',
      label: 'Failing',
      tone: 'danger',
      why: credential.capabilities.error ?? 'The last test of tool use failed',
    }
  if (
    credential.expiresAt !== undefined &&
    Date.parse(credential.expiresAt) - now.getTime() <= EXPIRING_DAYS * DAY_MS
  ) {
    const days = daysUntil(credential.expiresAt, now)
    return {
      state: 'expiring',
      label: 'Expires soon',
      tone: 'warning',
      why: days <= 0 ? 'Expires today' : `Expires in ${days} ${days === 1 ? 'day' : 'days'}`,
    }
  }
  const lastUse = Date.parse(credential.lastUsedAt ?? credential.createdAt)
  if (credential.usedBy?.length === 0 && now.getTime() - lastUse > UNUSED_DAYS * DAY_MS)
    return {
      state: 'unused',
      label: 'Unused',
      tone: 'default',
      why: credential.lastUsedAt
        ? `Nothing refers to it; last used ${formatRelative(credential.lastUsedAt, now)}`
        : 'Nothing refers to it and nothing used it',
    }
  return { state: 'healthy', label: 'Healthy', tone: 'success' }
}

/** Whether a credential needs someone: expired, failing or expiring soon. */
export const needsAttention = (status: CredentialStatus) =>
  status.state === 'expired' || status.state === 'failing' || status.state === 'expiring'

/** The Last used cell: `Never`, or how long ago, recorded to the minute. */
export function lastUsedLabel(lastUsedAt: string | undefined, now: Date): string {
  if (!lastUsedAt) return 'Never'
  return now.getTime() - Date.parse(lastUsedAt) < 60_000
    ? 'Within a minute'
    : formatRelative(lastUsedAt, now)
}

const stateOrder: Record<CredentialState, number> = {
  expired: 0,
  failing: 1,
  expiring: 2,
  unused: 3,
  healthy: 4,
}

/**
 * Credentials sorted by status (most urgent first), then by expiry (soonest first, none last),
 * then by name.
 */
export function sortCredentials<T extends StatusFields & Pick<CredentialView, 'name'>>(
  credentials: readonly T[],
  now: Date,
): T[] {
  const expiry = (credential: T) =>
    credential.expiresAt === undefined ? Infinity : Date.parse(credential.expiresAt)
  return credentials
    .map((credential) => ({
      credential,
      order: stateOrder[credentialStatus(credential, now).state],
    }))
    .toSorted(
      (a, b) =>
        a.order - b.order ||
        expiry(a.credential) - expiry(b.credential) ||
        a.credential.name.localeCompare(b.credential.name),
    )
    .map(({ credential }) => credential)
}

/** The Used by cell: what refers to the credential, `Nothing` when nothing does, `—` when unknown. */
export function usedByLabel(usedBy: CredentialView['usedBy']): string {
  if (usedBy === undefined) return '—'
  if (usedBy.length === 0) return 'Nothing'
  const [first, ...rest] = usedBy
  return rest.length ? `${first!.label} +${rest.length}` : first!.label
}

/** One configured request limit, as the Integrations table lists it. */
export interface LimitRow {
  /** The `limits.credentials` setting entry holding it. */
  settingId: string
  /** The key as stored: a credential id or name. */
  key: string
  /** The credential the key names, when one matches (by id first, then by name). */
  credential?: Pick<CredentialView, 'id' | 'name' | 'kind'>
  /** The configured fields in words, e.g. `300 requests/min · 8 at once`. */
  limit: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const limitFields: readonly [string, (value: number) => string][] = [
  ['requestsPerMinute', (v) => `${v.toLocaleString('en')} requests/min`],
  ['burst', (v) => `burst ${v.toLocaleString('en')}`],
  ['maxConcurrent', (v) => `${v} at once`],
  ['tokensPerMinute', (v) => `${v.toLocaleString('en')} tokens/min`],
  ['tokensPerDay', (v) => `${v.toLocaleString('en')} tokens/day`],
  ['costPerDayUsd', (v) => `$${v}/day`],
  ['pollShare', (v) => `${Math.round(v * 100)}% for polling`],
]

/**
 * The limits stored in `limits.credentials` setting entries, one row per configured key with only
 * the fields someone set; kind defaults are not listed.
 */
export function limitRows(
  entries: readonly { id: string; key: string; value: unknown; secret: boolean }[],
  credentials: readonly Pick<CredentialView, 'id' | 'name' | 'kind'>[],
): LimitRow[] {
  return entries.flatMap((entry) => {
    const value = entry.value
    if (entry.key !== 'limits.credentials' || entry.secret || !isRecord(value)) return []
    return Object.entries(value).flatMap(([key, policy]) => {
      if (!isRecord(policy)) return []
      const parts = limitFields.flatMap(([field, text]) => {
        const set = policy[field]
        return typeof set === 'number' ? [text(set)] : []
      })
      if (isRecord(policy.backoff)) parts.push('custom backoff')
      const credential =
        credentials.find((c) => c.id === key) ?? credentials.find((c) => c.name === key)
      return [
        {
          settingId: entry.id,
          key,
          ...(credential && { credential }),
          limit: parts.join(' · ') || 'Kind defaults',
        },
      ]
    })
  })
}
