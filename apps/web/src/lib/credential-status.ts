import type { CredentialView, LimitUsageRow } from '@holtkeeper/api'

import { daysUntil, formatCount, formatRelative } from './format.ts'

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

/** Share of an hourly or daily limit from which a credential reads as near its limit. */
const NEAR_LIMIT = 0.9

const HOUR_MS = 3_600_000

/** Where a credential stands against its request limits, most urgent first. */
type LimitState = 'capped' | 'cooling' | 'near' | 'within' | 'unlimited'

/** A credential's limit status in words with the tone that says the same, and why. */
export interface LimitStatus {
  state: LimitState
  label: string
  tone: 'danger' | 'warning' | 'default' | 'success'
  why?: string
}

/** Use of one rate over the last hour, its per-minute policy converted to an hourly limit. */
export interface HourMeter {
  unit: 'requests' | 'tokens'
  used: number
  /** The per-minute policy times 60. */
  max: number
  /** `used / max`, 0–1, capped at 1. */
  share: number
}

/** One row of the Request limits table, every cell in words. */
export interface LimitUsageView {
  key: string
  name: string
  kind?: string
  /** A configured key names no credential or forge. */
  missing: boolean
  /** e.g. `18,000 requests / hour`, or `No rate limit`. */
  limit: string
  /** e.g. `300 per minute · set here`. */
  limitDetail: string
  /** The busiest hourly rate; absent without one. */
  meter?: HourMeter
  /** e.g. `412 · 2%`, or `412 requests` without an hourly limit. */
  used: string
  /** e.g. `1 / 8`, or `1` without `maxConcurrent`. */
  atOnce: string
  /** e.g. `900 of 1,000,000 tokens · $0.50 of $150`, or `—` without a daily cap or use. */
  daily: string
  status: LimitStatus
}

const usd = (value: number) => (Number.isInteger(value) ? `$${value}` : `$${value.toFixed(2)}`)

const clockTime = (at: string) =>
  new Date(at).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })

function meters(row: LimitUsageRow): HourMeter[] {
  const list: HourMeter[] = []
  const add = (unit: HourMeter['unit'], perMinute: number | undefined, used: number) => {
    if (perMinute === undefined) return
    const max = perMinute * 60
    list.push({ unit, used, max, share: Math.min(1, used / max) })
  }
  add('requests', row.policy.requestsPerMinute, row.requestsLastHour)
  add('tokens', row.policy.tokensPerMinute, row.tokensLastHour)
  return list
}

const dailyShares = (row: LimitUsageRow) => [
  ...(row.policy.tokensPerDay ? [row.dayTokens / row.policy.tokensPerDay] : []),
  ...(row.policy.costPerDayUsd ? [row.dayCostUsd / row.policy.costPerDayUsd] : []),
]

/**
 * Where a credential stands: a daily cap used up, cooling down after a rate-limit answer, near a
 * limit (90% of an hourly or daily limit used, or rate limited within the last hour, which also
 * catches traffic Holtkeeper does not see), within its limits, or without any limit.
 */
export function limitStatus(row: LimitUsageRow, now: Date): LimitStatus {
  if (dailyShares(row).some((share) => share >= 1))
    return {
      state: 'capped',
      label: 'Daily cap reached',
      tone: 'danger',
      why: 'New work waits until midnight UTC',
    }
  if (row.coolDownUntil !== undefined && Date.parse(row.coolDownUntil) > now.getTime())
    return {
      state: 'cooling',
      label: `Cooling down until ${clockTime(row.coolDownUntil)}`,
      tone: 'warning',
      why: 'The service answered with a rate limit; everything using this credential waits',
    }
  const hourly = meters(row).find((meter) => meter.share >= NEAR_LIMIT)
  if (hourly)
    return {
      state: 'near',
      label: 'Near limit',
      tone: 'warning',
      why: `${Math.round(hourly.share * 100)}% of the hourly ${hourly.unit} limit used`,
    }
  const daily = dailyShares(row).find((share) => share >= NEAR_LIMIT)
  if (daily !== undefined)
    return {
      state: 'near',
      label: 'Near limit',
      tone: 'warning',
      why: `${Math.round(daily * 100)}% of the daily cap used`,
    }
  if (row.last429At !== undefined && now.getTime() - Date.parse(row.last429At) < HOUR_MS)
    return {
      state: 'near',
      label: 'Near limit',
      tone: 'warning',
      why: `Rate limited ${formatRelative(row.last429At, now)}`,
    }
  if (Object.keys(row.policy).length === 0)
    return { state: 'unlimited', label: 'No limit', tone: 'default' }
  return { state: 'within', label: 'Within limit', tone: 'success' }
}

/** One row of the Request limits table: per-minute policies shown per hour, every cell in words. */
function limitUsageView(row: LimitUsageRow, now: Date): LimitUsageView {
  const list = meters(row)
  const meter = list.toSorted((a, b) => b.share - a.share)[0]
  const perMinute = list.map(
    (m) => `${formatCount(m.max / 60)} ${m.unit === 'tokens' ? 'tokens ' : ''}per minute`,
  )
  const daily = [
    ...(row.policy.tokensPerDay !== undefined
      ? [`${formatCount(row.dayTokens)} of ${formatCount(row.policy.tokensPerDay)} tokens`]
      : row.dayTokens > 0
        ? [`${formatCount(row.dayTokens)} tokens today`]
        : []),
    ...(row.policy.costPerDayUsd !== undefined
      ? [`${usd(row.dayCostUsd)} of ${usd(row.policy.costPerDayUsd)}`]
      : []),
  ]
  const count =
    row.tokensLastHour > 0 && row.requestsLastHour === 0
      ? `${formatCount(row.tokensLastHour)} tokens`
      : `${formatCount(row.requestsLastHour)} requests`
  return {
    key: row.key,
    name: row.name,
    ...(row.kind !== undefined && { kind: row.kind }),
    missing: row.missing === true,
    limit: list.length
      ? list.map((m) => `${formatCount(m.max)} ${m.unit} / hour`).join(' · ')
      : 'No rate limit',
    limitDetail: [...perMinute, row.source === 'configured' ? 'set here' : 'kind default'].join(
      ' · ',
    ),
    ...(meter && { meter }),
    used: meter
      ? `${formatCount(meter.used)} · ${Math.round((meter.used / meter.max) * 100)}%`
      : count,
    atOnce:
      row.policy.maxConcurrent === undefined
        ? String(row.inFlight)
        : `${row.inFlight} / ${row.policy.maxConcurrent}`,
    daily: daily.join(' · ') || '—',
    status: limitStatus(row, now),
  }
}

const limitOrder: Record<LimitState, number> = {
  capped: 0,
  cooling: 1,
  near: 2,
  within: 3,
  unlimited: 4,
}

/** Rows of the Request limits table, most urgent first, then by name; keys naming nothing last. */
export function limitUsageViews(rows: readonly LimitUsageRow[], now: Date): LimitUsageView[] {
  return rows
    .map((row) => limitUsageView(row, now))
    .toSorted(
      (a, b) =>
        Number(a.missing) - Number(b.missing) ||
        limitOrder[a.status.state] - limitOrder[b.status.state] ||
        a.name.localeCompare(b.name),
    )
}
