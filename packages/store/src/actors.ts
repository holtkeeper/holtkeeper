import type { AuditActor } from './types.ts'

/**
 * Who accepts knowledge a policy lets through without review (`learnings.autoAccept`,
 * `guide.autoAccept`): the audit actor of those acceptances, and its `id` is what
 * `decidedBy`/`acceptedBy` hold.
 */
export const AUTO_ACCEPT_ACTOR: AuditActor = {
  id: 'auto-accept',
  name: 'Auto-accept',
  provider: 'system',
}
