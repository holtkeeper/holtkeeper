import type { AuditActor } from './types.ts'

/**
 * Who decides what a policy settles without a person (a learning activating after its approval
 * delay, say): the audit actor of those decisions, and its `id` is what `decidedBy` holds.
 */
export const AUTO_ACCEPT_ACTOR: AuditActor = {
  id: 'auto-accept',
  name: 'Auto-accept',
  provider: 'system',
}
