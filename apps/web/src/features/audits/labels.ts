import type { AuditTrigger } from '@holtkeeper/api'

/** Display name of what started a run. */
export const triggerLabel: Record<AuditTrigger, string> = {
  cli: 'CLI',
  schedule: 'Schedule',
  manual: 'Manual',
  webhook: 'Webhook',
}

/** Whether `value` names a trigger. */
export const isTrigger = (value: unknown): value is AuditTrigger =>
  typeof value === 'string' && Object.hasOwn(triggerLabel, value)

/** Filters of the audits list, kept in the URL; omitted keys are the defaults. */
export interface AuditsSearch {
  repo?: string
  /** `all` lists every run; the default lists the latest run of each repository. */
  view?: 'all'
  trigger?: AuditTrigger
  /** `open` keeps runs with active findings, `clean` runs without. */
  findings?: 'open' | 'clean'
}
