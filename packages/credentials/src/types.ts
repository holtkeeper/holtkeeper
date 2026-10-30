import type { Scope } from '@holtkeeper/access'
import type { RotationPolicy, Timestamp } from '@holtkeeper/store'

/**
 * Issues a fresh token for a service and inspects existing ones. One rotator per credential `kind`.
 * Implementations never include the token in error messages.
 */
export interface TokenRotator {
  /** Credential kind this rotator handles, e.g. `gitlab`. */
  readonly kind: string
  /**
   * Replaces `token` with a new one valid for about `lifetimeDays`. The old token may stop working
   * as soon as this call reaches the service, even if the promise then rejects.
   */
  rotate(input: {
    url: string
    token: string
    lifetimeDays: number
    signal?: AbortSignal
  }): Promise<RotatedToken>
  /** Reads what the service knows about `token` without changing it. */
  inspect?(input: { url: string; token: string; signal?: AbortSignal }): Promise<TokenInfo>
}

export interface RotatedToken {
  token: string
  expiresAt: Timestamp
}

export interface TokenInfo {
  expiresAt?: Timestamp
  name?: string
  scopes?: string[]
}

/** A credential without its secret. Safe to return to any caller allowed to see the credential. */
export interface CredentialView {
  id: string
  name: string
  kind: string
  url: string
  scope: Scope
  expiresAt?: Timestamp
  rotation?: RotationPolicy
  lastRotatedAt?: Timestamp
  lastError?: string
  /** Kind-specific, non-secret configuration (e.g. an AI provider's endpoint options). */
  options?: Record<string, unknown>
  createdAt: Timestamp
  updatedAt: Timestamp
}

/** Everything needed to store a new credential. `secret` is plaintext and is sealed before storage. */
export interface CreateCredentialInput {
  name: string
  kind: string
  url: string
  scope: Scope
  secret: string
  expiresAt?: Timestamp
  rotation?: RotationPolicy
  /**
   * Kind-specific configuration, stored in plain text: never put secrets here (header values may
   * reference the secret as `{secret}` instead). A JSON object of at most `MAX_OPTIONS_BYTES`.
   */
  options?: Record<string, unknown>
}

/**
 * Validates the `options` of credentials of a kind; returns `field: message` problems, `[]` when
 * they are fine. Return `undefined` for kinds the validator does not know.
 */
export type CredentialOptionsValidator = (
  kind: string,
  options: Record<string, unknown> | undefined,
) => string[] | undefined

/**
 * Fields to change; omitted fields keep their value. A new `secret` replaces the stored one; new
 * `options` replace the stored ones, and an empty object removes them.
 */
export type UpdateCredentialInput = Partial<CreateCredentialInput>

/** Outcome of one rotation attempted by `rotateDue`. */
export interface RotationResult {
  id: string
  ok: boolean
  error?: string
}
