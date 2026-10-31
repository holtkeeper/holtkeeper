import type { Grant } from '@holtkeeper/access'
import type { ActivityStore, User, UserStore } from '@holtkeeper/store'

import { type IssuedLink, issueLink } from './links.ts'

/** Grants of an administrator: every action on everything. */
export const adminGrants: Grant[] = [{ scope: { all: true }, actions: ['*'] }]

export interface ManageOptions {
  store: UserStore
  activity?: ActivityStore
  /** Who acts, recorded as `createdBy` and activity actor, e.g. `cli`. */
  actor: string
  now?: () => Date
}

/** The user whose id, email or exact name is `ref`; a name shared by several users matches none. */
export async function findUser(store: UserStore, ref: string): Promise<User | undefined> {
  const direct = (await store.getUser(ref)) ?? (await store.findUserByEmail(ref))
  if (direct) return direct
  const named = (await store.listUsers()).filter((user) => user.name === ref)
  return named.length === 1 ? named[0] : undefined
}

/**
 * Creates an enabled user without passkeys, bypassing delegation checks: only for operators with
 * access to the store. Throws when `email` already belongs to someone.
 */
export async function createUser(
  options: ManageOptions,
  input: { name: string; email?: string; grants: Grant[] },
): Promise<User> {
  const now = (options.now ?? (() => new Date()))()
  if (input.email && (await options.store.findUserByEmail(input.email)))
    throw new Error(`email ${input.email} is already in use`)
  const user: User = {
    id: crypto.randomUUID(),
    name: input.name,
    ...(input.email ? { email: input.email } : {}),
    grants: input.grants,
    disabled: false,
    sessionVersion: 1,
    createdAt: now.toISOString(),
    createdBy: options.actor,
  }
  await options.store.putUser(user)
  await options.activity?.append({
    at: now.toISOString(),
    actor: options.actor,
    action: 'user.invited',
    subject: user.id,
    details: { name: user.name, grants: user.grants },
  })
  return user
}

/**
 * A single-use link for `user`. `login` opens `/auth/users/link/<token>/login`, which signs the
 * holder in without a passkey, e.g. an AI agent driving the web UI; `enroll` and `recover` open the
 * web UI's passkey registration. `origin` is the public origin of the web UI.
 */
export async function issueUserLink(
  options: ManageOptions,
  input: { user: User; purpose: 'login' | 'enroll' | 'recover'; origin: string; ttlMs: number },
): Promise<IssuedLink> {
  const now = (options.now ?? (() => new Date()))()
  const issued = await issueLink(options.store, {
    origin: input.origin.replace(/\/+$/, ''),
    userId: input.user.id,
    purpose: input.purpose,
    ttlMs: input.ttlMs,
    now,
    createdBy: options.actor,
  })
  await options.activity?.append({
    at: now.toISOString(),
    actor: options.actor,
    action: 'user.link_issued',
    subject: input.user.id,
    details: { purpose: input.purpose, expiresAt: issued.expiresAt },
  })
  return issued
}
