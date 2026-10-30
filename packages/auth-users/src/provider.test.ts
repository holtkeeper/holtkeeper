import { describe, expect, test } from 'bun:test'

import type { Grant, Principal } from '@holtkeeper/access'
import type { AuthProvider } from '@holtkeeper/auth'
import { memoryStore } from '@holtkeeper/store/memory'

import type { OidcClaims, OidcClient } from './oidc-client.ts'
import type { OidcProviderOptions } from './options.ts'
import { createUsersAuth } from './provider.ts'
import type {
  ExternalAccountList,
  ExternalAccountView,
  LinkResponse,
  UserList,
  UserView,
} from './views.ts'
import { type WebAuthn, simpleWebAuthn } from './webauthn.ts'

const origin = 'https://keeper.example.com'

async function body<T>(response: Response): Promise<T> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return (await response.json()) as T
}

function defined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value')
  return value
}
const secret = 'x'.repeat(32)

const fakeWebAuthn: WebAuthn = {
  ...simpleWebAuthn(),
  async verifyRegistration(response, expected) {
    if (response.response.clientDataJSON !== expected.challenge || expected.origin !== origin)
      return undefined
    return { id: response.id, publicKey: new Uint8Array([1, 2, 3]), counter: 0 }
  },
  async verifyAuthentication(response, expected, credential) {
    if (response.response.clientDataJSON !== expected.challenge) return undefined
    return { newCounter: credential.counter + 1 }
  },
}

function fakeOidc(claims: () => OidcClaims) {
  const seen: { state?: string; nonce?: string; verifier?: string } = {}
  const client: OidcClient = {
    async authorizationUrl(input) {
      Object.assign(seen, { state: input.state, nonce: input.nonce, verifier: input.codeVerifier })
      return new URL(
        `https://idp.example.com/authorize?state=${input.state}&redirect_uri=${input.redirectUri}`,
      )
    },
    async callback({ callbackUrl, state, nonce, codeVerifier }) {
      if (callbackUrl.searchParams.get('state') !== state) throw new Error('state mismatch')
      if (nonce !== seen.nonce || codeVerifier !== seen.verifier) throw new Error('flow mismatch')
      return claims()
    },
  }
  return client
}

class Browser {
  jar = new Map<string, string>()

  async send(
    auth: AuthProvider,
    method: string,
    path: string,
    payload?: unknown,
    principal?: Principal,
  ) {
    const headers: Record<string, string> = {
      cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '),
    }
    if (payload !== undefined) headers['content-type'] = 'application/json'
    const request = new Request(`${origin}/auth/users${path}`, {
      method,
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
    })
    const response = await auth.handle?.(
      request,
      path.split('?')[0] ?? path,
      principal ?? (await auth.authenticate(request)),
    )
    if (!response) throw new Error(`no route for ${method} ${path}`)
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = ''] = cookie.split(';')
      const [name = '', ...value] = pair.split('=')
      if (cookie.includes('Max-Age=0')) this.jar.delete(name)
      else this.jar.set(name, value.join('='))
    }
    return response
  }

  async principal(auth: AuthProvider) {
    const cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ')
    return auth.authenticate(new Request(origin, { headers: { cookie } }))
  }
}

function setup(oidc: { options: OidcProviderOptions; client: OidcClient }[] = []) {
  const store = memoryStore()
  let clock = new Date('2026-10-29T12:00:00.000Z')
  const clients = new Map(oidc.map((o) => [o.options.id, o.client]))
  const auth = createUsersAuth(
    {
      store: store.users,
      activity: store.activity,
      sessionSecret: secret,
      origin,
      oidc: oidc.map((o) => o.options),
      externalAccounts: store.externalAccounts,
      forges: [{ id: 'work', kind: 'gitlab', url: 'https://gitlab.example.com/' }],
      bootstrap: { name: 'Root', email: 'root@example.com' },
      now: () => clock,
    },
    {
      webauthn: fakeWebAuthn,
      oidcClient: (options) =>
        clients.get(options.id) ?? fakeOidc(() => ({ subject: 'x', emailVerified: false })),
    },
  )
  return {
    store,
    auth,
    advance: (hours: number) => (clock = new Date(clock.getTime() + hours * 3_600_000)),
  }
}

const tokenOf = (link: string) => link.split('/link/')[1] ?? ''

async function enroll(
  auth: AuthProvider,
  link: string,
  browser = new Browser(),
  id: string = crypto.randomUUID(),
) {
  const token = tokenOf(link)
  const options = await body<{
    challenge: string
  }>(await browser.send(auth, 'POST', `/link/${token}/register/options`))
  const response = {
    id,
    rawId: id,
    type: 'public-key',
    response: { clientDataJSON: options.challenge },
    clientExtensionResults: {},
  }
  const verify = await browser.send(auth, 'POST', `/link/${token}/register/verify`, {
    response,
    label: 'laptop',
  })
  return { browser, verify, id }
}

async function login(auth: AuthProvider, passkeyId: string, browser = new Browser()) {
  const options = await body<{
    challenge: string
  }>(await browser.send(auth, 'POST', '/passkey/login/options'))
  const response = {
    id: passkeyId,
    rawId: passkeyId,
    type: 'public-key',
    response: { clientDataJSON: options.challenge },
    clientExtensionResults: {},
  }
  return {
    browser,
    verify: await browser.send(auth, 'POST', '/passkey/login/verify', { response }),
  }
}

async function rootSession() {
  const env = setup()
  const [line] = (await env.auth.start?.()) ?? []
  const link = /(https:\S+)/.exec(line ?? '')?.[1] ?? ''
  const { browser, id } = await enroll(env.auth, link)
  const root = defined(await browser.principal(env.auth))
  return { ...env, browser, root, passkeyId: id }
}

const repoGrant = (repos: string[], actions: Grant['actions']): Grant => ({
  scope: { repos },
  actions,
})

describe('usersAuth', () => {
  test('info lists passkeys and oidc providers', () => {
    const { auth } = setup([
      {
        options: {
          id: 'google',
          label: 'Google',
          issuer: 'https://accounts.example.com',
          clientId: 'c',
          clientSecret: 's',
        },
        client: fakeOidc(() => ({ subject: 'a', emailVerified: false })),
      },
    ])
    expect(auth.name).toBe('users')
    expect(auth.info()).toEqual({
      provider: 'users',
      methods: [
        { kind: 'passkey' },
        { kind: 'oidc', id: 'google', label: 'Google', url: '/auth/users/oidc/google/login' },
      ],
      logoutUrl: '/auth/users/logout',
    })
  })

  test('start bootstraps a root admin once', async () => {
    const { auth, store } = setup()
    const lines = (await auth.start?.()) ?? []
    expect(lines[0]).toMatch(
      /^No users yet\. Set up the first admin passkey: https:\/\/keeper\.example\.com\/link\/[\w-]{43} \(expires 2026-11-01T12:00:00\.000Z\)$/,
    )
    const [user] = await store.users.listUsers()
    expect(user?.grants).toEqual([{ scope: { all: true }, actions: ['*'] }])
    const link = /(https:\S+)/.exec(lines[0] ?? '')?.[1] ?? ''
    await enroll(auth, link)
    expect(await auth.start?.()).toEqual([])
  })

  test('enrollment registers a passkey, signs in and burns the link', async () => {
    const { auth, store, browser, root, passkeyId } = await rootSession()
    expect(root).toMatchObject({ name: 'Root', email: 'root@example.com', provider: 'users' })
    const passkeys = await store.users.listPasskeys(root.id)
    expect(passkeys).toMatchObject([{ id: passkeyId, label: 'laptop', publicKey: 'AQID' }])

    const invited = await body<LinkResponse>(
      await browser.send(auth, 'POST', '/admin/users', { name: 'Ann', grants: [] }, root),
    )
    const token = tokenOf(invited.link)
    expect((await browser.send(auth, 'GET', `/link/${token}`)).status).toBe(200)
    await enroll(auth, invited.link)
    const again = await new Browser().send(auth, 'GET', `/link/${token}`)
    expect(again.status).toBe(410)
    expect((await new Browser().send(auth, 'POST', `/link/${token}/register/options`)).status).toBe(
      410,
    )
  })

  test('link info, unknown and expired links', async () => {
    const { auth, browser, root, advance } = await rootSession()
    const invited = await body<LinkResponse>(
      await browser.send(auth, 'POST', '/admin/users', { name: 'Ann', grants: [] }, root),
    )
    const info = await body<unknown>(
      await new Browser().send(auth, 'GET', `/link/${tokenOf(invited.link)}`),
    )
    expect(info).toEqual({ purpose: 'enroll', userName: 'Ann', expiresAt: invited.expiresAt })
    expect((await new Browser().send(auth, 'GET', `/link/${'a'.repeat(43)}`)).status).toBe(404)
    advance(73)
    expect((await new Browser().send(auth, 'GET', `/link/${tokenOf(invited.link)}`)).status).toBe(
      410,
    )
  })

  test('registration needs the challenge cookie of the same link', async () => {
    const { auth, browser, root } = await rootSession()
    const invited = await body<LinkResponse>(
      await browser.send(auth, 'POST', '/admin/users', { name: 'Ann', grants: [] }, root),
    )
    const token = tokenOf(invited.link)
    const response = {
      id: 'k',
      rawId: 'k',
      type: 'public-key',
      response: { clientDataJSON: 'forged' },
      clientExtensionResults: {},
    }
    expect(
      (await new Browser().send(auth, 'POST', `/link/${token}/register/verify`, { response }))
        .status,
    ).toBe(400)
    expect(
      (await new Browser().send(auth, 'POST', `/link/${token}/register/verify`, { nope: 1 }))
        .status,
    ).toBe(400)
  })

  test('passkey login updates the counter and rejects disabled users', async () => {
    const { auth, store, root, passkeyId, advance } = await rootSession()
    advance(1)
    const { browser, verify } = await login(auth, passkeyId)
    expect(verify.status).toBe(204)
    expect((await browser.principal(auth))?.id).toBe(root.id)
    expect(await store.users.getPasskey(passkeyId)).toMatchObject({
      counter: 1,
      lastUsedAt: '2026-10-29T13:00:00.000Z',
    })
    expect((await login(auth, 'unknown')).verify.status).toBe(401)

    await store.users.putUser({ ...defined(await store.users.getUser(root.id)), disabled: true })
    expect(await browser.principal(auth)).toBeUndefined()
    expect((await login(auth, passkeyId)).verify.status).toBe(403)
  })

  test('login without a challenge cookie fails', async () => {
    const { auth, passkeyId } = await rootSession()
    const response = {
      id: passkeyId,
      rawId: passkeyId,
      type: 'public-key',
      response: { clientDataJSON: 'x' },
      clientExtensionResults: {},
    }
    expect(
      (await new Browser().send(auth, 'POST', '/passkey/login/verify', { response })).status,
    ).toBe(400)
  })

  test('sessions expire and logout clears the cookie', async () => {
    const { auth, browser, advance, passkeyId } = await rootSession()
    expect((await browser.send(auth, 'POST', '/logout')).status).toBe(204)
    expect(await browser.principal(auth)).toBeUndefined()
    const { browser: other } = await login(auth, passkeyId)
    expect(await other.principal(auth)).toBeDefined()
    advance(13)
    expect(await other.principal(auth)).toBeUndefined()
  })

  test('recovery registers a new passkey and ends old sessions', async () => {
    const { auth, store, browser, root } = await rootSession()
    const ann = await body<LinkResponse>(
      await browser.send(auth, 'POST', '/admin/users', { name: 'Ann', grants: [] }, root),
    )
    const { browser: annBrowser } = await enroll(auth, ann.link)
    expect(await annBrowser.principal(auth)).toBeDefined()

    const recovery = await browser.send(
      auth,
      'POST',
      `/admin/users/${ann.user.id}/recovery`,
      undefined,
      root,
    )
    expect(recovery.status).toBe(201)
    const { link } = await body<LinkResponse>(recovery)
    const { browser: newDevice } = await enroll(auth, link)
    expect(await annBrowser.principal(auth)).toBeUndefined()
    expect((await newDevice.principal(auth))?.id).toBe(ann.user.id)
    expect(await store.users.listPasskeys(ann.user.id)).toHaveLength(2)
    const actions = (await store.activity.list()).map((e) => e.action)
    expect(actions).toEqual(
      expect.arrayContaining([
        'user.invited',
        'passkey.registered',
        'user.recovery_issued',
        'user.recovered',
        'user.login',
      ]),
    )
  })

  test('cross-origin writes are rejected', async () => {
    const { auth } = setup()
    const request = new Request(`${origin}/auth/users/logout`, {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    })
    expect((await auth.handle?.(request, '/logout', undefined))?.status).toBe(403)
  })

  test('unknown paths fall through, wrong methods get 405', async () => {
    const { auth } = setup()
    expect(await auth.handle?.(new Request(`${origin}/x`), '/nope', undefined)).toBeUndefined()
    expect((await auth.handle?.(new Request(`${origin}/x`), '/logout', undefined))?.status).toBe(
      405,
    )
  })
})

describe('admin api', () => {
  test('requires a signed-in caller', async () => {
    const { auth } = setup()
    expect((await new Browser().send(auth, 'GET', '/admin/users')).status).toBe(401)
  })

  test('invites only within the caller grants', async () => {
    const { auth, browser, root } = await rootSession()
    const lead = repoGrant(
      ['games/**'],
      ['users:read', 'users:invite', 'users:write', 'repos:read'],
    )
    const invited = await body<LinkResponse>(
      await browser.send(
        auth,
        'POST',
        '/admin/users',
        { name: 'Lead', email: 'lead@example.com', grants: [lead] },
        root,
      ),
    )
    const { browser: leadBrowser } = await enroll(auth, invited.link)
    const leadPrincipal = defined(await leadBrowser.principal(auth))

    const narrow = repoGrant(['games/slots/**'], ['repos:read'])
    const ok = await leadBrowser.send(
      auth,
      'POST',
      '/admin/users',
      { name: 'Dev', grants: [narrow] },
      leadPrincipal,
    )
    expect(ok.status).toBe(201)
    const wide = await leadBrowser.send(
      auth,
      'POST',
      '/admin/users',
      { name: 'X', grants: [{ scope: { all: true }, actions: ['repos:read'] }] },
      leadPrincipal,
    )
    expect(wide.status).toBe(403)
    const dup = await browser.send(
      auth,
      'POST',
      '/admin/users',
      { name: 'Y', email: 'LEAD@example.com', grants: [] },
      root,
    )
    expect(dup.status).toBe(409)
    const bad = await browser.send(
      auth,
      'POST',
      '/admin/users',
      { name: 'Y', grants: [{ scope: {}, actions: ['fly'] }] },
      root,
    )
    expect(bad.status).toBe(400)

    const seen = (
      await body<UserList>(
        await leadBrowser.send(auth, 'GET', '/admin/users', undefined, leadPrincipal),
      )
    ).users
    expect(seen.map((u) => u.name).toSorted()).toEqual(['Dev', 'Lead'])
    const all = (
      await body<UserList>(await browser.send(auth, 'GET', '/admin/users', undefined, root))
    ).users
    expect(all.map((u) => u.name)).toEqual(['Root', 'Lead', 'Dev'])
    expect(all[0]?.passkeys).toHaveLength(1)
    expect(all[0]?.passkeys[0]).not.toHaveProperty('publicKey')

    const rootId = all[0]?.id ?? ''
    expect(
      (
        await leadBrowser.send(
          auth,
          'PATCH',
          `/admin/users/${rootId}`,
          { name: 'Pwned' },
          leadPrincipal,
        )
      ).status,
    ).toBe(404)
    expect(
      (
        await leadBrowser.send(
          auth,
          'POST',
          `/admin/users/${rootId}/recovery`,
          undefined,
          leadPrincipal,
        )
      ).status,
    ).toBe(404)
  })

  test('patch rules: no self-escalation, disabling and grant changes end sessions', async () => {
    const { auth, browser, root, store } = await rootSession()
    expect(
      (await browser.send(auth, 'PATCH', `/admin/users/${root.id}`, { disabled: true }, root))
        .status,
    ).toBe(403)
    expect(
      (await browser.send(auth, 'PATCH', `/admin/users/${root.id}`, { grants: [] }, root)).status,
    ).toBe(403)
    const renamed = await browser.send(
      auth,
      'PATCH',
      `/admin/users/${root.id}`,
      { name: 'Boss' },
      root,
    )
    expect((await body<UserView>(renamed)).name).toBe('Boss')
    expect(await browser.principal(auth)).toBeDefined()

    const ann = await body<LinkResponse>(
      await browser.send(
        auth,
        'POST',
        '/admin/users',
        { name: 'Ann', grants: [repoGrant(['a/**'], ['repos:read'])] },
        root,
      ),
    )
    const { browser: annBrowser } = await enroll(auth, ann.link)
    const annPrincipal = defined(await annBrowser.principal(auth))
    expect(
      (
        await annBrowser.send(
          auth,
          'PATCH',
          `/admin/users/${ann.user.id}`,
          { name: 'A' },
          annPrincipal,
        )
      ).status,
    ).toBe(404)

    const patched = await browser.send(
      auth,
      'PATCH',
      `/admin/users/${ann.user.id}`,
      { grants: [repoGrant(['b/**'], ['repos:read'])] },
      root,
    )
    expect(patched.status).toBe(200)
    expect(await annBrowser.principal(auth)).toBeUndefined()
    expect((await store.users.getUser(ann.user.id))?.sessionVersion).toBe(2)

    await browser.send(auth, 'PATCH', `/admin/users/${ann.user.id}`, { disabled: true }, root)
    expect((await store.users.getUser(ann.user.id))?.sessionVersion).toBe(3)
    expect(
      (await browser.send(auth, 'PATCH', '/admin/users/missing', { name: 'x' }, root)).status,
    ).toBe(404)
  })

  test('deleting a passkey checks ownership', async () => {
    const { auth, browser, root, passkeyId, store } = await rootSession()
    const ann = await body<LinkResponse>(
      await browser.send(auth, 'POST', '/admin/users', { name: 'Ann', grants: [] }, root),
    )
    const { id } = await enroll(auth, ann.link)
    expect(
      (
        await browser.send(
          auth,
          'DELETE',
          `/admin/users/${ann.user.id}/passkeys/${passkeyId}`,
          undefined,
          root,
        )
      ).status,
    ).toBe(404)
    expect(
      (
        await browser.send(
          auth,
          'DELETE',
          `/admin/users/${ann.user.id}/passkeys/${id}`,
          undefined,
          root,
        )
      ).status,
    ).toBe(204)
    expect(await store.users.listPasskeys(ann.user.id)).toEqual([])
  })
})

const oidcOptions = (extra: Partial<OidcProviderOptions> = {}): OidcProviderOptions => ({
  id: 'corp',
  label: 'Corp',
  issuer: 'https://idp.example.com',
  clientId: 'client',
  clientSecret: 'secret',
  ...extra,
})

async function signIn(auth: AuthProvider) {
  const browser = new Browser()
  const start = await browser.send(auth, 'GET', '/oidc/corp/login')
  expect(start.status).toBe(302)
  const location = new URL(start.headers.get('location') ?? '')
  expect(location.searchParams.get('redirect_uri')).toBe(`${origin}/auth/users/oidc/corp/callback`)
  const state = location.searchParams.get('state') ?? ''
  const response = await browser.send(auth, 'GET', `/oidc/corp/callback?code=abc&state=${state}`)
  return { browser, response }
}

async function addPasskey(auth: AuthProvider, browser: Browser, id: string, label = 'phone') {
  const options = await body<{ challenge: string; excludeCredentials?: { id: string }[] }>(
    await browser.send(auth, 'POST', '/me/passkeys/options'),
  )
  const response = {
    id,
    rawId: id,
    type: 'public-key',
    response: { clientDataJSON: options.challenge },
    clientExtensionResults: {},
  }
  const verify = await browser.send(auth, 'POST', '/me/passkeys/verify', { response, label })
  return { options, verify }
}

describe('own account', () => {
  test('needs a session', async () => {
    const { auth } = setup()
    expect((await new Browser().send(auth, 'GET', '/me')).status).toBe(401)
    expect((await new Browser().send(auth, 'POST', '/me/passkeys/options')).status).toBe(401)
  })

  test('shows the account and adds, renames and removes passkeys', async () => {
    const { auth, store, browser, root, passkeyId } = await rootSession()
    const me = await body<UserView>(await browser.send(auth, 'GET', '/me'))
    expect(me).toMatchObject({ id: root.id, name: 'Root' })
    expect(me.passkeys.map((p) => p.id)).toEqual([passkeyId])

    const { options, verify } = await addPasskey(auth, browser, 'pk-phone')
    expect(options.excludeCredentials?.map((c) => c.id)).toEqual([passkeyId])
    expect(verify.status).toBe(201)
    expect((await body<UserView>(verify)).passkeys.map((p) => p.label)).toEqual(['laptop', 'phone'])
    expect((await login(auth, 'pk-phone')).verify.status).toBe(204)

    const renamed = await browser.send(auth, 'PATCH', '/me/passkeys/pk-phone', { label: ' work ' })
    expect((await body<UserView>(renamed)).passkeys[1]?.label).toBe('work')
    expect((await browser.send(auth, 'PATCH', '/me/passkeys/pk-phone', { label: '' })).status).toBe(
      400,
    )

    expect((await browser.send(auth, 'DELETE', '/me/passkeys/pk-phone')).status).toBe(204)
    expect((await store.users.listPasskeys(root.id)).map((p) => p.id)).toEqual([passkeyId])
    const actions = (await store.activity.list()).map((e) => e.action)
    expect(actions).toEqual(
      expect.arrayContaining(['passkey.registered', 'passkey.renamed', 'passkey.removed']),
    )
  })

  test('keeps the only passkey and only touches own ones', async () => {
    const { auth, store, browser, root, passkeyId } = await rootSession()
    const only = await browser.send(auth, 'DELETE', `/me/passkeys/${passkeyId}`)
    expect(only.status).toBe(409)

    const invited = await body<LinkResponse>(
      await browser.send(auth, 'POST', '/admin/users', { name: 'Other', grants: [] }, root),
    )
    const other = await enroll(auth, invited.link, new Browser(), 'pk-other')
    expect((await browser.send(auth, 'DELETE', '/me/passkeys/pk-other')).status).toBe(404)
    expect(
      (await browser.send(auth, 'PATCH', '/me/passkeys/pk-other', { label: 'mine' })).status,
    ).toBe(404)
    expect(await store.users.getPasskey('pk-other')).toBeDefined()
    expect(other.verify.status).toBe(204)
  })

  test('adding needs the challenge issued to the same user', async () => {
    const { auth, browser } = await rootSession()
    const response = {
      id: 'pk-x',
      rawId: 'pk-x',
      type: 'public-key',
      response: { clientDataJSON: 'nope' },
      clientExtensionResults: {},
    }
    expect((await browser.send(auth, 'POST', '/me/passkeys/verify', { response })).status).toBe(400)
    await browser.send(auth, 'POST', '/passkey/login/options')
    expect((await browser.send(auth, 'POST', '/me/passkeys/verify', { response })).status).toBe(400)
  })
})

describe('oidc', () => {
  test('links a verified email to an existing user and signs in', async () => {
    let claims: OidcClaims = { subject: 's1', email: 'ROOT@example.com', emailVerified: true }
    const env = setup([{ options: oidcOptions(), client: fakeOidc(() => claims) }])
    await env.auth.start?.()
    const { browser, response } = await signIn(env.auth)
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/')
    expect((await browser.principal(env.auth))?.name).toBe('Root')
    expect((await env.store.users.findIdentity('corp', 's1'))?.userId).toBeDefined()

    claims = { subject: 's1', emailVerified: false }
    expect((await signIn(env.auth)).response.status).toBe(302)
  })

  test('unverified email of an existing user is not linked', async () => {
    const env = setup([
      {
        options: oidcOptions(),
        client: fakeOidc(() => ({
          subject: 's2',
          email: 'root@example.com',
          emailVerified: false,
        })),
      },
    ])
    await env.auth.start?.()
    expect((await signIn(env.auth)).response.status).toBe(403)
  })

  test('sign-up honours allowSignup and email domains', async () => {
    let claims: OidcClaims = {
      subject: 'n1',
      email: 'new@corp.example',
      emailVerified: true,
      name: 'New',
    }
    const grants = [repoGrant(['x/**'], ['repos:read'])]
    const env = setup([
      {
        options: oidcOptions({
          allowSignup: true,
          emailDomains: ['corp.example'],
          defaultGrants: grants,
        }),
        client: fakeOidc(() => claims),
      },
    ])
    const { browser, response } = await signIn(env.auth)
    expect(response.status).toBe(302)
    expect(await browser.principal(env.auth)).toMatchObject({
      name: 'New',
      email: 'new@corp.example',
      grants,
    })

    claims = { subject: 'n2', email: 'other@else.example', emailVerified: true }
    expect((await signIn(env.auth)).response.status).toBe(403)
  })

  test('callback without the flow cookie or with a bad state fails', async () => {
    const env = setup([
      {
        options: oidcOptions({ allowSignup: true }),
        client: fakeOidc(() => ({ subject: 'q', emailVerified: false })),
      },
    ])
    expect(
      (await new Browser().send(env.auth, 'GET', '/oidc/corp/callback?code=a&state=b')).status,
    ).toBe(400)
    const browser = new Browser()
    await browser.send(env.auth, 'GET', '/oidc/corp/login')
    expect(
      (await browser.send(env.auth, 'GET', '/oidc/corp/callback?code=a&state=wrong')).status,
    ).toBe(401)
    expect((await browser.send(env.auth, 'GET', '/oidc/unknown/login')).status).toBe(404)
  })
})

describe('external accounts', () => {
  test('admins link, list and unlink accounts of users they manage', async () => {
    const { auth, browser, root, store } = await rootSession()
    const lead = repoGrant(['games/**'], ['users:read', 'users:invite', 'users:write'])
    const leadUser = await body<LinkResponse>(
      await browser.send(auth, 'POST', '/admin/users', { name: 'Lead', grants: [lead] }, root),
    )
    expect(leadUser.user.avatarUrl).toBe(`/api/avatars/${leadUser.user.id}.svg`)
    const dev = await body<LinkResponse>(
      await browser.send(
        auth,
        'POST',
        '/admin/users',
        { name: 'Dev', grants: [repoGrant(['games/slots/**'], ['repos:read'])] },
        root,
      ),
    )
    const path = `/admin/users/${dev.user.id}/accounts`

    const bad = await browser.send(
      auth,
      'POST',
      path,
      { provider: 'gitlab:work', externalId: 'dev' },
      root,
    )
    expect(bad.status).toBe(400)

    await store.externalAccounts?.put({
      id: 'claim',
      userId: leadUser.user.id,
      provider: 'gitlab:work',
      externalId: '7',
      verification: 'unverified',
      linkedBy: leadUser.user.id,
      linkedAt: '2026-10-29T12:00:00.000Z',
    })
    const created = await browser.send(
      auth,
      'POST',
      path,
      { provider: 'gitlab:work', externalId: '7', username: 'dev' },
      root,
    )
    expect(created.status).toBe(201)
    const account = await body<ExternalAccountView>(created)
    expect(account).toMatchObject({
      userId: dev.user.id,
      verification: 'admin',
      linkedBy: root.id,
      username: 'dev',
    })
    expect(await store.externalAccounts?.get('claim')).toBeUndefined()

    const listed = await body<ExternalAccountList>(
      await browser.send(auth, 'GET', path, undefined, root),
    )
    expect(listed.accounts).toEqual([account])

    const other = await browser.send(
      auth,
      'POST',
      `/admin/users/${leadUser.user.id}/accounts`,
      { provider: 'gitlab:work', externalId: '7' },
      root,
    )
    expect(other.status).toBe(409)

    const outsider = {
      id: 'x',
      name: 'X',
      provider: 'users',
      grants: [repoGrant(['tools/**'], ['users:read', 'users:write'])],
    }
    expect((await browser.send(auth, 'GET', path, undefined, outsider)).status).toBe(404)
    const reader = { ...outsider, grants: [repoGrant(['games/**'], ['users:read', 'repos:read'])] }
    expect((await browser.send(auth, 'GET', path, undefined, reader)).status).toBe(200)
    expect(
      (await browser.send(auth, 'POST', path, { provider: 'slack:T1', externalId: 'U1' }, reader))
        .status,
    ).toBe(403)

    expect((await browser.send(auth, 'DELETE', `${path}/missing`, undefined, root)).status).toBe(
      404,
    )
    expect(
      (await browser.send(auth, 'DELETE', `${path}/${account.id}`, undefined, root)).status,
    ).toBe(204)
    expect(await store.externalAccounts?.listByUser(dev.user.id)).toEqual([])
    const events = await store.activity.list()
    expect(events.map((e) => e.action)).toContain('account.unlinked')
  })

  test('sign-in through a GitLab forge issuer links the subject as a verified account', async () => {
    const claims: OidcClaims = {
      subject: '1234',
      email: 'root@example.com',
      emailVerified: true,
      username: 'root.gl',
    }
    const env = setup([
      {
        options: oidcOptions({ issuer: 'https://gitlab.example.com' }),
        client: fakeOidc(() => claims),
      },
    ])
    await env.auth.start?.()
    expect((await signIn(env.auth)).response.status).toBe(302)
    const linked = await env.store.externalAccounts?.find('gitlab:work', '1234')
    expect(linked).toMatchObject({
      verification: 'oidc',
      username: 'root.gl',
      linkedBy: 'oidc:corp',
    })
    expect((await signIn(env.auth)).response.status).toBe(302)
    expect(await env.store.externalAccounts?.list()).toHaveLength(1)
  })

  test('other issuers link nothing unless linkAccounts says so', async () => {
    const claims: OidcClaims = { subject: 'abc', email: 'root@example.com', emailVerified: true }
    const plain = setup([{ options: oidcOptions(), client: fakeOidc(() => claims) }])
    await plain.auth.start?.()
    await signIn(plain.auth)
    expect(await plain.store.externalAccounts?.list()).toEqual([])

    const explicit = setup([
      { options: oidcOptions({ linkAccounts: 'slack:T1' }), client: fakeOidc(() => claims) },
    ])
    await explicit.auth.start?.()
    await signIn(explicit.auth)
    expect((await explicit.store.externalAccounts?.find('slack:T1', 'abc'))?.verification).toBe(
      'oidc',
    )
  })
})
