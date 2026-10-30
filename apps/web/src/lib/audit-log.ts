import type { AuditEvent, AuditVerifyResponse } from '@holtkeeper/api'

import type { AuditLogQuery } from '../api/endpoints.ts'

/** The audit log filter form: text fields as typed, dates as `YYYY-MM-DD`. */
export interface AuditLogForm {
  actor: string
  action: string
  targetType: string
  targetId: string
  repo: string
  /** `''` for any. */
  outcome: string
  /** `''` for any. */
  via: string
  fromDay: string
  toDay: string
}

/** A form with every field empty. */
export const emptyAuditForm: AuditLogForm = {
  actor: '',
  action: '',
  targetType: '',
  targetId: '',
  repo: '',
  outcome: '',
  via: '',
  fromDay: '',
  toDay: '',
}

const dayPattern = /^\d{4}-\d{2}-\d{2}$/

const nextDay = (day: string): string => {
  const date = new Date(`${day}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString()
}

/**
 * The API query for a form: trimmed, empty fields dropped, `fromDay` from its midnight (UTC) and
 * `toDay` through its end, since the API's `to` is exclusive.
 */
export function auditQueryOf(form: AuditLogForm): AuditLogQuery {
  const query: AuditLogQuery = {}
  for (const key of [
    'actor',
    'action',
    'targetType',
    'targetId',
    'repo',
    'outcome',
    'via',
  ] as const) {
    const value = form[key].trim()
    if (value) query[key] = value
  }
  if (dayPattern.test(form.fromDay)) query.from = `${form.fromDay}T00:00:00.000Z`
  if (dayPattern.test(form.toDay)) query.to = nextDay(form.toDay)
  return query
}

/** How many filters a query applies. */
export const activeFilters = (query: AuditLogQuery): number =>
  Object.values(query).filter((value) => value !== undefined && value !== '').length

/** Chip tone of an outcome. */
export const outcomeTone = (outcome: string): 'success' | 'warning' | 'danger' | 'default' =>
  outcome === 'ok'
    ? 'success'
    : outcome === 'denied'
      ? 'warning'
      : outcome === 'error'
        ? 'danger'
        : 'default'

/** Text color class of an HTTP status. */
export const statusClass = (status: number | undefined): string =>
  status === undefined
    ? 'text-muted'
    : status >= 500
      ? 'text-danger'
      : status >= 400
        ? 'text-warning'
        : 'text-muted'

/** `credential:abc` or just the type when the target has no id. */
export const targetLabel = (target: AuditEvent['target']): string =>
  target.id ? `${target.type}:${target.id}` : target.type

/** A change value as text: `—` when absent, strings as is, everything else as JSON. */
export function changeValue(value: unknown): string {
  if (value === undefined) return '—'
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

/** Whether an event has anything to show when expanded. */
export const hasDetails = (event: AuditEvent): boolean =>
  Boolean(
    event.changes?.length ||
    (event.details && Object.keys(event.details).length) ||
    event.request ||
    event.target.repo,
  )

const brokenReason = {
  hash: 'its content does not match its hash',
  link: 'it does not link to the event before it',
  gap: 'events before it are missing',
  tail: 'events at the end of the range are missing',
} as const

/** A verification result as a notice: tone, title and explanation. */
export function verificationSummary(result: AuditVerifyResponse): {
  tone: 'success' | 'danger'
  title: string
  description: string
} {
  const range =
    result.firstSeq !== undefined && result.lastSeq !== undefined
      ? ` (#${result.firstSeq}–#${result.lastSeq})`
      : ''
  if (result.ok || !result.broken)
    return {
      tone: 'success',
      title: 'Chain intact',
      description: `${result.checked} ${result.checked === 1 ? 'event' : 'events'} checked${range}.`,
    }
  return {
    tone: 'danger',
    title: `Chain broken at #${result.broken.seq}`,
    description: `${brokenReason[result.broken.reason]}; ${result.checked} checked${range}.`,
  }
}
