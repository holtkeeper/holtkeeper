import type { AuditSummary, AuditVerification, Timestamp } from '@holtkeeper/store'

import type { PersonView } from './types.ts'

/** One component of `SystemHealth`: `error` when it does not answer, `warn` when it needs a look. */
export interface SystemHealthCheck {
  id: 'store' | 'migrations' | 'artifacts' | 'workers' | 'library-index' | 'retired-read-only'
  label: string
  status: 'ok' | 'warn' | 'error'
  /** What the status means in words, e.g. `answering`, `3 workers`, `indexing 142 of 412`. */
  detail?: string
}

/**
 * `GET /api/system/health` — Settings › System at a glance, measured on request; needs a global
 * `settings:read`. `status` is the worst of the checks.
 */
export interface SystemHealth {
  status: 'ok' | 'warn' | 'error'
  checks: SystemHealthCheck[]
  checkedAt: Timestamp
  storage: {
    totalBytes: number
    /** UTC day (`YYYY-MM-DD`) of the newest daily snapshot at least seven days old; absent without one. */
    since?: string
    /** Total bytes in that snapshot. */
    weekAgoBytes?: number
    /** Bytes per storage area id (`StorageProviderView.id`) in that snapshot. */
    weekAgo?: Record<string, number>
  }
  /** Workers that reported their disks in the last 15 minutes. */
  workers: number
  /** The running release, `HOLTKEEPER_VERSION`; absent when unknown. */
  version?: string
  /** When the answering process started. */
  startedAt: Timestamp
}

/**
 * `GET /api/history/summary` — counts of the audit events the caller may see, with the same
 * filters as `GET /api/history`; without a global `audit:read` only their repositories' events.
 */
export interface HistorySummary extends AuditSummary {
  people: Record<string, PersonView>
}

/**
 * `GET /api/audit/verify/last` — the newest daily check of the whole chain; needs a global
 * `audit:read`. Both fields are absent before the first check.
 */
export interface AuditVerifyLast {
  at?: Timestamp
  result?: AuditVerification
}
