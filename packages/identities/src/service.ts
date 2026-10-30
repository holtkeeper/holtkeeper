import { type Action, type Principal, type RepoTarget, can } from '@holtkeeper/access'
import type {
  AuditStore,
  AuditVia,
  ExternalAccount,
  ExternalAccountStore,
  Timestamp,
  UserStore,
} from '@holtkeeper/store'

import {
  challengeMatches,
  generateChallengeCode,
  hashChallengeCode,
  verifyCommand,
} from './challenge.ts'
import { type LinkInput, linkInputSchema } from './providers.ts'

/** Why an identity operation was refused; `code` maps to HTTP 400, 403, 404 and 409. */
export class IdentityError extends Error {
  readonly code: 'invalid' | 'forbidden' | 'not-found' | 'conflict'

  constructor(code: IdentityError['code'], message: string) {
    super(message)
    this.name = 'IdentityError'
    this.code = code
  }
}

/** Configuration of `createIdentities`. */
export interface IdentitiesOptions {
  accounts: ExternalAccountStore
  /** Stored users; linked users are turned into principals with their current grants. */
  users?: Pick<UserStore, 'getUser'>
  /**
   * Builds the principal behind a verified link. Default: the stored user (disabled or missing
   * users give none), else the principal snapshot kept for auth providers without stored users.
   */
  principalFor?: (account: ExternalAccount) => Promise<Principal | undefined>
  /** Receives an `account.verify` event for every answered challenge. */
  audit?: AuditStore
  /** Default 30. */
  challengeTtlMinutes?: number
  /** Wrong codes before a challenge is dropped. Default 5. */
  maxChallengeAttempts?: number
  /** Links one principal may hold. Default 20. */
  maxLinksPerUser?: number
  now?: () => Date
}

/** A challenge code, shown once. */
export interface IssuedChallenge {
  code: string
  expiresAt: Timestamp
  /** What to post as a merge request or issue comment, or send to the bot. */
  command: string
}

/** What a webhook or bot saw: who posted a code, and the code. */
export interface ChallengeAnswer {
  provider: string
  externalId: string
  username?: string
  code: string
  /** Default `webhook`. */
  via?: AuditVia
}

export type ChallengeResult =
  | { ok: true; account: ExternalAccount }
  | {
      ok: false
      reason:
        | 'not-linked'
        | 'already-verified'
        | 'no-challenge'
        | 'expired'
        | 'wrong-code'
        | 'too-many-attempts'
    }

/** Whether an external actor may perform an action, and as whom. */
export interface ExternalAuthorization {
  allowed: boolean
  principal?: Principal
  reason: 'allowed' | 'not-linked' | 'unverified' | 'no-principal' | 'forbidden'
}

/** External accounts of principals: self-service links, challenges and resolving external actors. */
export interface Identities {
  /** The caller's links, oldest first. */
  list(principal: Principal): Promise<ExternalAccount[]>
  /**
   * Links an account to the caller as `unverified`. Linking an account the caller already holds
   * returns it; an unverified link of someone else is taken over; a verified one is a conflict.
   */
  link(principal: Principal, input: unknown): Promise<ExternalAccount>
  unlink(principal: Principal, id: string): Promise<void>
  /** Issues a fresh code for an unverified link of the caller, replacing any earlier one. */
  issueChallenge(principal: Principal, id: string): Promise<IssuedChallenge>
  /** Verifies the link `(provider, externalId)` when `code` is its pending challenge. */
  completeChallenge(answer: ChallengeAnswer): Promise<ChallengeResult>
  /** The principal behind a verified link, with its current grants; unverified links give none. */
  resolveExternalActor(ref: {
    provider: string
    externalId: string
  }): Promise<Principal | undefined>
  /** Whether the external actor may perform `action` on the repository (groups included). */
  authorizeExternal(input: {
    provider: string
    externalId: string
    action: Action
    repo: RepoTarget
  }): Promise<ExternalAuthorization>
}

/** Whether a link counts for authorization. */
export const isVerified = (account: ExternalAccount) => account.verification !== 'unverified'

const snapshotOf = (principal: Principal): ExternalAccount['principal'] =>
  principal.provider === 'users'
    ? undefined
    : { name: principal.name, provider: principal.provider, grants: principal.grants }

/**
 * Self-service and resolution of external accounts. Admin links (`admin`) and OIDC links
 * (`oidc`) are written by `@holtkeeper/auth-users`; this service writes `unverified` links and
 * upgrades them to `challenge` when the person posts their code from that account.
 */
export function createIdentities(options: IdentitiesOptions): Identities {
  const { accounts } = options
  const now = options.now ?? (() => new Date())
  const ttlMs = (options.challengeTtlMinutes ?? 30) * 60_000
  const maxAttempts = options.maxChallengeAttempts ?? 5
  const maxLinks = options.maxLinksPerUser ?? 20

  const principalFor =
    options.principalFor ??
    (async (account: ExternalAccount): Promise<Principal | undefined> => {
      const user = await options.users?.getUser(account.userId)
      if (user)
        return user.disabled
          ? undefined
          : {
              id: user.id,
              name: user.name,
              ...(user.email !== undefined && { email: user.email }),
              provider: 'users',
              grants: user.grants,
            }
      const snapshot = account.principal
      if (!snapshot || snapshot.provider === 'users') return undefined
      return { id: account.userId, ...snapshot }
    })

  const refresh = async (principal: Principal, account: ExternalAccount) => {
    const snapshot = snapshotOf(principal)
    if (!snapshot || JSON.stringify(snapshot) === JSON.stringify(account.principal)) return account
    const updated = { ...account, principal: snapshot }
    await accounts.put(updated)
    return updated
  }

  const own = async (principal: Principal, id: string) => {
    const account = await accounts.get(id)
    if (account?.userId !== principal.id) throw new IdentityError('not-found', 'account not found')
    return account
  }

  async function verifiedPrincipal(ref: {
    provider: string
    externalId: string
  }): Promise<{ principal?: Principal; reason: ExternalAuthorization['reason'] }> {
    const account = await accounts.find(ref.provider, ref.externalId)
    if (!account) return { reason: 'not-linked' }
    if (!isVerified(account)) return { reason: 'unverified' }
    const principal = await principalFor(account)
    return principal ? { principal, reason: 'allowed' } : { reason: 'no-principal' }
  }

  async function record(answer: ChallengeAnswer, ok: boolean, details: Record<string, unknown>) {
    await options.audit?.append({
      at: now().toISOString(),
      actor: {
        id: `${answer.provider}:${answer.externalId}`,
        name: answer.username ?? answer.externalId,
        provider: answer.provider,
      },
      via: answer.via ?? 'webhook',
      action: 'account.verify',
      target: { type: 'account', id: `${answer.provider}:${answer.externalId}` },
      outcome: ok ? 'ok' : 'denied',
      details,
    })
  }

  return {
    async list(principal) {
      const links = await accounts.listByUser(principal.id)
      return Promise.all(links.map((account) => refresh(principal, account)))
    },

    async link(principal, raw) {
      const parsed = linkInputSchema.safeParse(raw)
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        throw new IdentityError(
          'invalid',
          `${issue?.path.join('.') || 'input'}: ${issue?.message ?? 'invalid'}`,
        )
      }
      const input: LinkInput = parsed.data
      const existing = await accounts.find(input.provider, input.externalId)
      if (existing?.userId === principal.id) {
        const updated =
          input.username && input.username !== existing.username && !isVerified(existing)
            ? { ...existing, username: input.username }
            : existing
        if (updated !== existing) await accounts.put(updated)
        return refresh(principal, updated)
      }
      if (existing && isVerified(existing))
        throw new IdentityError('conflict', 'this account is already linked to someone else')
      if ((await accounts.listByUser(principal.id)).length >= maxLinks)
        throw new IdentityError('invalid', `at most ${maxLinks} linked accounts`)
      if (existing) await accounts.remove(existing.id)
      const snapshot = snapshotOf(principal)
      const account: ExternalAccount = {
        id: crypto.randomUUID(),
        userId: principal.id,
        provider: input.provider,
        externalId: input.externalId,
        ...(input.username !== undefined && { username: input.username }),
        verification: 'unverified',
        linkedBy: principal.id,
        linkedAt: now().toISOString(),
        ...(snapshot && { principal: snapshot }),
      }
      await accounts.put(account)
      return account
    },

    async unlink(principal, id) {
      await accounts.remove((await own(principal, id)).id)
    },

    async issueChallenge(principal, id) {
      const account = await refresh(principal, await own(principal, id))
      if (isVerified(account)) throw new IdentityError('conflict', 'account is already verified')
      const code = generateChallengeCode()
      const expiresAt = new Date(now().getTime() + ttlMs).toISOString()
      await accounts.put({
        ...account,
        challenge: { hash: hashChallengeCode(account.id, code), expiresAt, attempts: 0 },
      })
      return { code, expiresAt, command: verifyCommand(code) }
    },

    async completeChallenge(answer) {
      const account = await accounts.find(answer.provider, answer.externalId)
      if (!account) {
        await record(answer, false, { reason: 'not-linked' })
        return { ok: false, reason: 'not-linked' }
      }
      const { challenge, ...rest } = account
      if (!challenge) {
        const reason = isVerified(account) ? 'already-verified' : 'no-challenge'
        await record(answer, false, { reason, userId: account.userId })
        return { ok: false, reason }
      }
      const at = now()
      const fail = async (
        reason: 'expired' | 'wrong-code' | 'too-many-attempts',
        keep: boolean,
      ) => {
        await accounts.put(
          keep
            ? { ...account, challenge: { ...challenge, attempts: challenge.attempts + 1 } }
            : rest,
        )
        await record(answer, false, { reason, userId: account.userId })
        return { ok: false as const, reason }
      }
      if (challenge.expiresAt <= at.toISOString()) return fail('expired', false)
      if (!challengeMatches(account.id, answer.code, challenge.hash)) {
        return challenge.attempts + 1 >= maxAttempts
          ? fail('too-many-attempts', false)
          : fail('wrong-code', true)
      }
      const verified: ExternalAccount = {
        ...rest,
        ...(answer.username !== undefined && { username: answer.username }),
        verification: 'challenge',
        verifiedAt: at.toISOString(),
      }
      await accounts.put(verified)
      await record(answer, true, { userId: account.userId, accountId: account.id })
      return { ok: true, account: verified }
    },

    async resolveExternalActor(ref) {
      return (await verifiedPrincipal(ref)).principal
    },

    async authorizeExternal({ provider, externalId, action, repo }) {
      const found = await verifiedPrincipal({ provider, externalId })
      if (!found.principal) return { allowed: false, reason: found.reason }
      return can(found.principal, action, { kind: 'repo', repo })
        ? { allowed: true, principal: found.principal, reason: 'allowed' }
        : { allowed: false, principal: found.principal, reason: 'forbidden' }
    },
  }
}
