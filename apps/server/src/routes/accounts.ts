import type { AccountChallenge, ExternalAccountList, ExternalAccountView } from '@holtkeeper/api'
import { type Identities, IdentityError, createIdentities } from '@holtkeeper/identities'
import type { ExternalAccount } from '@holtkeeper/store'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'

import { type Env, type ServerDeps, principalOf } from '../context.ts'

const statusOf = { invalid: 400, forbidden: 403, 'not-found': 404, conflict: 409 } as const

/** Runs an identity operation, turning `IdentityError`s into HTTP errors. */
async function attempt<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof IdentityError)
      throw new HTTPException(statusOf[error.code], { message: error.message })
    throw error
  }
}

/** The challenge hash and principal snapshot stay on the server. */
const toAccountView = (account: ExternalAccount): ExternalAccountView => ({
  id: account.id,
  userId: account.userId,
  provider: account.provider,
  externalId: account.externalId,
  ...(account.username !== undefined && { username: account.username }),
  verification: account.verification,
  linkedBy: account.linkedBy,
  linkedAt: account.linkedAt,
  ...(account.verifiedAt !== undefined && { verifiedAt: account.verifiedAt }),
  ...(account.challenge && { challengeExpiresAt: account.challenge.expiresAt }),
})

/**
 * The identities service over the server's store, or `undefined` when the store keeps no external
 * accounts. Webhooks and bots use it for `completeChallenge`, `resolveExternalActor` and
 * `authorizeExternal`.
 */
export function identitiesFor(deps: Pick<ServerDeps, 'store' | 'now'>): Identities | undefined {
  const accounts = deps.store.externalAccounts
  if (!accounts) return undefined
  return createIdentities({
    accounts,
    users: deps.store.users,
    ...(deps.store.audit && { audit: deps.store.audit }),
    now: deps.now,
  })
}

/**
 * The caller's own external accounts: list, link (unverified), unlink and issue a challenge code.
 * Admin links live under `/auth/users/admin/users/:id/accounts`.
 */
export function accountRoutes(deps: ServerDeps) {
  const app = new Hono<Env>()
  const identities = identitiesFor(deps)
  const service = () => {
    if (!identities)
      throw new HTTPException(503, { message: 'external accounts are not configured' })
    return identities
  }

  app.get('/accounts', async (c) => {
    const principal = principalOf(c)
    const accounts = await service().list(principal)
    return c.json<ExternalAccountList>({ accounts: accounts.map(toAccountView) })
  })

  app.post('/accounts', async (c) => {
    const principal = principalOf(c)
    const body: unknown = await c.req.json().catch(() => undefined)
    const account = await attempt(() => service().link(principal, body))
    c.set('audit', {
      action: 'account.link',
      target: { type: 'account', id: account.id },
      changes: [
        { field: 'provider', after: account.provider },
        { field: 'externalId', after: account.externalId },
        { field: 'verification', after: account.verification },
      ],
    })
    return c.json<ExternalAccountView>(toAccountView(account), 201)
  })

  app.delete('/accounts/:id', async (c) => {
    const principal = principalOf(c)
    await attempt(() => service().unlink(principal, c.req.param('id')))
    c.set('audit', { action: 'account.unlink', target: { type: 'account', id: c.req.param('id') } })
    return c.body(null, 204)
  })

  app.post('/accounts/:id/challenge', async (c) => {
    const principal = principalOf(c)
    const issued = await attempt(() => service().issueChallenge(principal, c.req.param('id')))
    c.set('audit', {
      action: 'account.challenge',
      target: { type: 'account', id: c.req.param('id') },
      details: { expiresAt: issued.expiresAt },
    })
    return c.json<AccountChallenge>(issued, 201)
  })

  return app
}
