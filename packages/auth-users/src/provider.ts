import type { Principal } from '@holtkeeper/access'
import { type AuthProvider, json } from '@holtkeeper/auth'
import { resolveSecret } from '@holtkeeper/forge'
import { z } from 'zod'

import {
  accountLinkSchema,
  accountProviderFor,
  linkUserAccount,
  listUserAccounts,
  unlinkUserAccount,
} from './accounts.ts'
import {
  inviteSchema,
  inviteUser,
  issueRecovery,
  listUsers,
  removePasskey,
  updateSchema,
  updateUser,
} from './admin.ts'
import { bootstrapUsers } from './bootstrap.ts'
import { type Context, activityLogger } from './context.ts'
import { signedCookie } from './cookies.ts'
import { HttpError, readBody } from './errors.ts'
import { linkInfo, markLinkUsed, openLink } from './links.ts'
import {
  addPasskey,
  addPasskeyOptions,
  removeOwnPasskey,
  renamePasskey,
  renamePasskeySchema,
  selfUser,
} from './me.ts'
import { type OidcClientFactory, openidClient } from './oidc-client.ts'
import { finishOidcLogin, startOidcLogin } from './oidc.ts'
import type { UsersAuthOptions } from './options.ts'
import {
  loginBody,
  loginOptions,
  registerBody,
  registrationOptions,
  verifyLogin,
  verifyRegistration,
} from './passkeys.ts'
import { type Route, createRouter } from './router.ts'
import { principalOf, sessionUser, startSession } from './sessions.ts'
import { type ExternalAccountList, type UserList, toUserView } from './views.ts'
import { type WebAuthn, simpleWebAuthn } from './webauthn.ts'

/** Replaceable dependencies; tests swap in fakes. */
export interface UsersAuthDeps {
  webauthn?: WebAuthn
  oidcClient?: OidcClientFactory
}

const withCookies = (response: Response, cookies: string[]) => {
  for (const cookie of cookies) response.headers.append('set-cookie', cookie)
  return response
}

const noContent = (...cookies: string[]) =>
  withCookies(new Response(null, { status: 204 }), cookies)

const redirect = (location: string, ...cookies: string[]) =>
  withCookies(new Response(null, { status: 302, headers: { location } }), cookies)

const signedIn = (principal: Principal | undefined) => {
  if (!principal) throw new HttpError(401, 'not signed in')
  return principal
}

function buildContext(options: UsersAuthOptions, deps: UsersAuthDeps): Context {
  const url = new URL(options.origin)
  const origin = url.origin
  const now = options.now ?? (() => new Date())
  const secret = resolveSecret(options.sessionSecret)
  const secure = options.secureCookies ?? url.protocol === 'https:'
  const cookie = { secret, secure, now }
  const factory = deps.oidcClient ?? openidClient

  return {
    store: options.store,
    origin,
    rpID: url.hostname,
    rpName: options.rpName ?? 'Holtkeeper',
    linkTtlMs: (options.linkTtlHours ?? 72) * 3_600_000,
    now,
    sessions: signedCookie({
      ...cookie,
      name: 'hk_session',
      purpose: 'session',
      ttlSeconds: (options.sessionTtlHours ?? 12) * 3600,
      schema: z.object({ uid: z.string(), v: z.number() }),
    }),
    challenges: signedCookie({
      ...cookie,
      name: 'hk_webauthn',
      purpose: 'webauthn',
      ttlSeconds: 300,
      schema: z.object({
        c: z.string(),
        k: z.enum(['login', 'register', 'add']),
        t: z.string().optional(),
      }),
    }),
    oidcFlows: signedCookie({
      ...cookie,
      name: 'hk_oidc',
      purpose: 'oidc',
      ttlSeconds: 600,
      schema: z.object({ p: z.string(), s: z.string(), n: z.string(), v: z.string() }),
    }),
    webauthn: deps.webauthn ?? simpleWebAuthn(),
    oidc: new Map((options.oidc ?? []).map((o) => [o.id, { options: o, client: factory(o) }])),
    ...(options.externalAccounts && { accounts: options.externalAccounts }),
    accountProviderFor: (id) => {
      const oidc = options.oidc?.find((o) => o.id === id)
      return oidc && accountProviderFor(oidc, options.forges)
    },
    log: activityLogger(options.activity, now),
  }
}

function routes(ctx: Context): Route<Principal | undefined>[] {
  return [
    {
      method: 'POST',
      pattern: '/passkey/login/options',
      async handler() {
        const { options, cookie } = await loginOptions(ctx)
        return withCookies(json(options), [cookie])
      },
    },
    {
      method: 'POST',
      pattern: '/passkey/login/verify',
      async handler(request) {
        const { response } = await readBody(request, loginBody)
        const user = await verifyLogin(ctx, request, response)
        return noContent(await startSession(ctx, user), ctx.challenges.clear())
      },
    },
    {
      method: 'GET',
      pattern: '/link/:token',
      handler: async (_request, { token = '' }) =>
        json(linkInfo(await openLink(ctx.store, token, ctx.now()))),
    },
    {
      method: 'POST',
      pattern: '/link/:token/register/options',
      async handler(_request, { token = '' }) {
        const { options, cookie } = await registrationOptions(ctx, token)
        return withCookies(json(options), [cookie])
      },
    },
    {
      method: 'POST',
      pattern: '/link/:token/register/verify',
      async handler(request, { token = '' }) {
        const body = await readBody(request, registerBody)
        const user = await verifyRegistration(ctx, request, token, body)
        return noContent(await startSession(ctx, user), ctx.challenges.clear())
      },
    },
    {
      method: 'GET',
      pattern: '/link/:token/login',
      async handler(_request, { token = '' }) {
        const now = ctx.now()
        const { link, user } = await openLink(ctx.store, token, now, ['login'])
        await markLinkUsed(ctx.store, link, now)
        await ctx.log(user.id, 'user.login', user.id, { method: 'link' })
        return redirect('/', await startSession(ctx, user))
      },
    },
    {
      method: 'GET',
      pattern: '/oidc/:id/login',
      async handler(_request, { id = '' }) {
        const { location, cookie } = await startOidcLogin(ctx, id)
        return redirect(location, cookie)
      },
    },
    {
      method: 'GET',
      pattern: '/oidc/:id/callback',
      async handler(request, { id = '' }) {
        const user = await finishOidcLogin(ctx, request, id)
        return redirect('/', await startSession(ctx, user), ctx.oidcFlows.clear())
      },
    },
    {
      method: 'POST',
      pattern: '/logout',
      handler: async () => noContent(ctx.sessions.clear()),
    },
    {
      method: 'GET',
      pattern: '/me',
      handler: async (_request, _params, principal) =>
        json(await toUserView(ctx.store, await selfUser(ctx, principal))),
    },
    {
      method: 'POST',
      pattern: '/me/passkeys/options',
      async handler(_request, _params, principal) {
        const { options, cookie } = await addPasskeyOptions(ctx, await selfUser(ctx, principal))
        return withCookies(json(options), [cookie])
      },
    },
    {
      method: 'POST',
      pattern: '/me/passkeys/verify',
      async handler(request, _params, principal) {
        const user = await selfUser(ctx, principal)
        await addPasskey(ctx, request, user, await readBody(request, registerBody))
        return withCookies(json(await toUserView(ctx.store, user), { status: 201 }), [
          ctx.challenges.clear(),
        ])
      },
    },
    {
      method: 'PATCH',
      pattern: '/me/passkeys/:passkeyId',
      async handler(request, { passkeyId = '' }, principal) {
        const user = await selfUser(ctx, principal)
        await renamePasskey(ctx, user, passkeyId, await readBody(request, renamePasskeySchema))
        return json(await toUserView(ctx.store, user))
      },
    },
    {
      method: 'DELETE',
      pattern: '/me/passkeys/:passkeyId',
      async handler(_request, { passkeyId = '' }, principal) {
        await removeOwnPasskey(ctx, await selfUser(ctx, principal), passkeyId)
        return noContent()
      },
    },
    {
      method: 'GET',
      pattern: '/admin/users',
      handler: async (_request, _params, principal) =>
        json({ users: await listUsers(ctx, signedIn(principal)) } satisfies UserList),
    },
    {
      method: 'POST',
      pattern: '/admin/users',
      async handler(request, _params, principal) {
        const caller = signedIn(principal)
        return json(await inviteUser(ctx, caller, await readBody(request, inviteSchema)), {
          status: 201,
        })
      },
    },
    {
      method: 'PATCH',
      pattern: '/admin/users/:id',
      async handler(request, { id = '' }, principal) {
        const caller = signedIn(principal)
        return json(await updateUser(ctx, caller, id, await readBody(request, updateSchema)))
      },
    },
    {
      method: 'POST',
      pattern: '/admin/users/:id/recovery',
      handler: async (_request, { id = '' }, principal) =>
        json(await issueRecovery(ctx, signedIn(principal), id), { status: 201 }),
    },
    {
      method: 'DELETE',
      pattern: '/admin/users/:id/passkeys/:passkeyId',
      async handler(_request, { id = '', passkeyId = '' }, principal) {
        await removePasskey(ctx, signedIn(principal), id, passkeyId)
        return noContent()
      },
    },
    {
      method: 'GET',
      pattern: '/admin/users/:id/accounts',
      handler: async (_request, { id = '' }, principal) =>
        json({
          accounts: await listUserAccounts(ctx, signedIn(principal), id),
        } satisfies ExternalAccountList),
    },
    {
      method: 'POST',
      pattern: '/admin/users/:id/accounts',
      async handler(request, { id = '' }, principal) {
        const caller = signedIn(principal)
        const input = await readBody(request, accountLinkSchema)
        return json(await linkUserAccount(ctx, caller, id, input), { status: 201 })
      },
    },
    {
      method: 'DELETE',
      pattern: '/admin/users/:id/accounts/:accountId',
      async handler(_request, { id = '', accountId = '' }, principal) {
        await unlinkUserAccount(ctx, signedIn(principal), id, accountId)
        return noContent()
      },
    },
  ]
}

/** `usersAuth` with injectable WebAuthn and OIDC implementations. */
export function createUsersAuth(options: UsersAuthOptions, deps: UsersAuthDeps = {}): AuthProvider {
  const ctx = buildContext(options, deps)
  const router = createRouter(routes(ctx))

  return {
    name: 'users',
    async authenticate(request) {
      const user = await sessionUser(ctx, request)
      return user && principalOf(user)
    },
    async handle(request, path, principal) {
      const sentFrom = request.headers.get('origin')
      if (
        request.method !== 'GET' &&
        request.method !== 'HEAD' &&
        sentFrom &&
        sentFrom !== ctx.origin
      ) {
        return json({ error: 'cross-origin request rejected' }, { status: 403 })
      }
      return router(request, path, principal)
    },
    info: () => ({
      provider: 'users',
      methods: [
        { kind: 'passkey' },
        ...(options.oidc ?? []).map((o) => ({
          kind: 'oidc' as const,
          id: o.id,
          label: o.label,
          url: `/auth/users/oidc/${encodeURIComponent(o.id)}/login`,
        })),
      ],
      logoutUrl: '/auth/users/logout',
    }),
    async start() {
      if (!options.bootstrap) return []
      const issued = await bootstrapUsers({
        store: options.store,
        origin: ctx.origin,
        name: options.bootstrap.name,
        email: options.bootstrap.email,
        linkTtlHours: options.linkTtlHours,
        now: ctx.now,
      })
      return issued
        ? [
            `No users yet. Set up the first admin passkey: ${issued.link} (expires ${issued.expiresAt})`,
          ]
        : []
    },
  }
}

/**
 * Accounts with passkeys and optional OpenID Connect sign-in. Sessions are signed cookies that
 * end when the user is disabled, their grants change or they recover access. Endpoints live under
 * `/auth/users/`; see the module docs for routes and permission rules.
 */
export const usersAuth = (options: UsersAuthOptions): AuthProvider => createUsersAuth(options)
