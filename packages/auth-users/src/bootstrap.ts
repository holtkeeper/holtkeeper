import type { UserStore } from '@holtkeeper/store'

import { type IssuedLink, issueLink } from './links.ts'

export interface BootstrapOptions {
  store: UserStore
  /** Public origin of the web UI; the link is `${origin}/link/<token>`. */
  origin: string
  name: string
  email?: string
  /** Default 72. */
  linkTtlHours?: number
  now?: () => Date
}

const bootstrapCreator = 'bootstrap'

/**
 * Creates the first admin (every action on everything) when the store has no users and returns a
 * one-time link for enrolling their passkey. When the only user is a bootstrap admin who never
 * registered a passkey, issues a fresh link instead, so a lost startup log does not lock the
 * instance. Otherwise returns `undefined`.
 */
export async function bootstrapUsers(options: BootstrapOptions): Promise<IssuedLink | undefined> {
  const { store } = options
  const now = (options.now ?? (() => new Date()))()
  const ttlMs = (options.linkTtlHours ?? 72) * 3_600_000
  const users = await store.listUsers()

  let userId: string
  if (users.length === 0) {
    userId = crypto.randomUUID()
    await store.putUser({
      id: userId,
      name: options.name,
      email: options.email,
      grants: [{ scope: { all: true }, actions: ['*'] }],
      disabled: false,
      sessionVersion: 1,
      createdAt: now.toISOString(),
      createdBy: bootstrapCreator,
    })
  } else {
    const [only] = users
    if (users.length !== 1 || !only || only.createdBy !== bootstrapCreator) return undefined
    if ((await store.listPasskeys(only.id)).length > 0) return undefined
    userId = only.id
  }
  return issueLink(store, {
    origin: options.origin,
    userId,
    purpose: 'enroll',
    ttlMs,
    now,
    createdBy: bootstrapCreator,
  })
}
