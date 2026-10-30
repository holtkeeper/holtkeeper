import type { AuditTrigger } from '@holtkeeper/api'

/** Display name of what started a run. */
export const triggerLabel: Record<AuditTrigger, string> = {
  cli: 'CLI',
  schedule: 'Schedule',
  manual: 'Manual',
  webhook: 'Webhook',
}
