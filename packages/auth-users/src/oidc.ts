import type { User } from '@holtkeeper/store'

import { linkOidcAccount } from './accounts.ts'
import type { Context } from './context.ts'
import { HttpError } from './errors.ts'
import type { OidcClaims } from './oidc-client.ts'
import type { OidcProviderOptions } from './options.ts'
import { randomToken } from './tokens.ts'

const defaultScopes = ['openid', 'email', 'profile']

const callbackUri = (ctx: Context, id: string) =>
  `${ctx.origin}/auth/users/oidc/${encodeURIComponent(id)}/callback`

function provider(ctx: Context, id: string) {
  const entry = ctx.oidc.get(id)
  if (!entry) throw new HttpError(404, 'unknown sign-in provider')
  return entry
}

/** Where to send the browser to sign in with provider `id`, and the cookie holding the flow secrets. */
export async function startOidcLogin(
  ctx: Context,
  id: string,
): Promise<{ location: string; cookie: string }> {
  const { options, client } = provider(ctx, id)
  const flow = { p: id, s: randomToken(), n: randomToken(), v: randomToken() }
  const url = await client.authorizationUrl({
    redirectUri: callbackUri(ctx, id),
    scope: (options.scopes ?? defaultScopes).join(' '),
    state: flow.s,
    nonce: flow.n,
    codeVerifier: flow.v,
  })
  return { location: url.href, cookie: await ctx.oidcFlows.issue(flow) }
}

const domainAllowed = (options: OidcProviderOptions, claims: OidcClaims) => {
  if (!options.emailDomains) return true
  const email = claims.emailVerified ? claims.email?.toLowerCase() : undefined
  return (
    !!email && options.emailDomains.some((domain) => email.endsWith(`@${domain.toLowerCase()}`))
  )
}

/**
 * The user signing in with these claims: a linked identity, else an existing user with the same
 * verified email (the identity gets linked), else a new user when sign-up is allowed.
 * Throws 403 otherwise or when the user is disabled.
 */
async function resolveOidcUser(
  ctx: Context,
  options: OidcProviderOptions,
  claims: OidcClaims,
): Promise<User> {
  const { store } = ctx
  const identity = await store.findIdentity(options.id, claims.subject)
  let user = identity && (await store.getUser(identity.userId))

  if (!user && claims.emailVerified && claims.email) {
    user = await store.findUserByEmail(claims.email)
    if (user && !user.disabled) {
      await store.putIdentity({
        provider: options.id,
        subject: claims.subject,
        userId: user.id,
        email: claims.email,
      })
      await ctx.log(user.id, 'identity.linked', user.id, { provider: options.id })
    }
  }

  if (!user) {
    if (!options.allowSignup || !domainAllowed(options, claims))
      throw new HttpError(403, 'no account for this sign-in')
    const email = claims.emailVerified ? claims.email : undefined
    user = {
      id: crypto.randomUUID(),
      name: claims.name ?? email ?? claims.subject,
      email,
      grants: options.defaultGrants ?? [],
      disabled: false,
      sessionVersion: 1,
      createdAt: ctx.now().toISOString(),
      createdBy: `oidc:${options.id}`,
    }
    await store.putUser(user)
    await store.putIdentity({
      provider: options.id,
      subject: claims.subject,
      userId: user.id,
      email: claims.email,
    })
    await ctx.log(user.id, 'user.signed_up', user.id, { provider: options.id })
  }

  if (user.disabled) throw new HttpError(403, 'account is disabled')
  await linkOidcAccount(ctx, options, user, claims)
  await ctx.log(user.id, 'user.login', user.id, { method: 'oidc', provider: options.id })
  return user
}

/** Completes the authorization code flow started by `startOidcLogin`. */
export async function finishOidcLogin(ctx: Context, request: Request, id: string): Promise<User> {
  const { options, client } = provider(ctx, id)
  const flow = await ctx.oidcFlows.read(request)
  if (flow?.p !== id) throw new HttpError(400, 'sign-in expired, try again')
  let claims: OidcClaims
  try {
    claims = await client.callback({
      callbackUrl: new URL(`${callbackUri(ctx, id)}${new URL(request.url).search}`),
      state: flow.s,
      nonce: flow.n,
      codeVerifier: flow.v,
    })
  } catch {
    throw new HttpError(401, 'sign-in was rejected')
  }
  return resolveOidcUser(ctx, options, claims)
}
