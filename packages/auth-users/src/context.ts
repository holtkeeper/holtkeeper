import type { AuditStore, ExternalAccountStore, KvStore, UserStore } from '@holtkeeper/store'

import type { SignedCookie } from './cookies.ts'
import type { OidcClient } from './oidc-client.ts'
import type { OidcProviderOptions } from './options.ts'
import type { WebAuthn } from './webauthn.ts'

interface SessionPayload {
  uid: string
  v: number
}

interface ChallengePayload {
  c: string
  k: 'login' | 'register' | 'add'
  /** Link token hash of a registration, or user id of an added passkey. */
  t?: string
}

interface OidcFlow {
  p: string
  s: string
  n: string
  v: string
}

/** Everything the flows share; built once by the provider. */
export interface Context {
  store: UserStore
  kv?: Pick<KvStore, 'get' | 'set'>
  origin: string
  rpID: string
  rpName: string
  linkTtlMs: number
  now: () => Date
  sessions: SignedCookie<SessionPayload>
  challenges: SignedCookie<ChallengePayload>
  oidcFlows: SignedCookie<OidcFlow>
  webauthn: WebAuthn
  oidc: Map<string, { options: OidcProviderOptions; client: OidcClient }>
  accounts?: ExternalAccountStore
  /** External account provider OIDC sign-ins with this provider id link to, if any. */
  accountProviderFor(oidcId: string): string | undefined
  log(
    actor: string,
    action: string,
    subject?: string,
    details?: Record<string, unknown>,
  ): Promise<void>
}

/** Appends what users do to the audit log under their current name; without a log, nothing. */
export function auditLogger(
  audit: Pick<AuditStore, 'append'> | undefined,
  store: UserStore,
  now: () => Date,
): Context['log'] {
  return async (actor, action, subject, details) => {
    if (!audit) return
    const user = await store.getUser(actor)
    await audit.append({
      at: now().toISOString(),
      actor: { id: actor, name: user?.name ?? actor, provider: 'users' },
      via: 'ui',
      action,
      target: { type: 'user', ...(subject !== undefined && { id: subject }) },
      outcome: 'ok',
      ...(details && { details }),
    })
  }
}
