import type { ActivityStore, ExternalAccountStore, UserStore } from '@holtkeeper/store'

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
  k: 'login' | 'register'
  /** Link token hash a registration challenge belongs to. */
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

export function activityLogger(
  activity: ActivityStore | undefined,
  now: () => Date,
): Context['log'] {
  return async (actor, action, subject, details) => {
    if (!activity) return
    await activity.append({ at: now().toISOString(), actor, action, subject, details })
  }
}
