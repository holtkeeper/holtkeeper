import type { LinkRole } from '@holtkeeper/api'

import { roleLabels } from './access.ts'

/** Name shown for a passkey: its label, else its position. */
export const passkeyName = (passkey: { label?: string }, index: number): string =>
  passkey.label?.trim() || `Passkey ${index + 1}`

/** Whether a WebAuthn error means the person closed or declined the browser prompt. */
export const isCancelled = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'NotAllowedError' || error.name === 'AbortError')

/**
 * What a setup link grants, as the link page shows it before sign-in: the role and the number of
 * grants, never their scopes (`Custom access · 2 grants`).
 */
export function linkGrantsText(grants: { count: number; role: LinkRole }): string {
  if (grants.count === 0) return 'No access yet'
  return `${roleLabels[grants.role]} access · ${grants.count} grant${grants.count === 1 ? '' : 's'}`
}
