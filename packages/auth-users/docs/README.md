# @holtkeeper/auth-users

An `AuthProvider` (name `users`) with real accounts: passkeys for everyone, optional OpenID Connect
sign-in, one-time links for enrollment and recovery, and an admin API that only lets people hand
out access they already have.

```ts
import { usersAuth } from '@holtkeeper/auth-users'

const auth = usersAuth({
  store: store.users,
  activity: store.activity,
  sessionSecret: { env: 'HOLTKEEPER_SESSION_SECRET' },
  origin: 'https://keeper.example.com',
  bootstrap: { name: 'Admin', email: 'admin@example.com' },
  oidc: [
    {
      id: 'corp',
      label: 'Corp SSO',
      issuer: 'https://login.corp.example',
      clientId: 'holtkeeper',
      clientSecret: { env: 'OIDC_SECRET' },
      allowSignup: true,
      emailDomains: ['corp.example'],
      defaultGrants: [{ scope: { groups: ['public'] }, actions: ['repos:read', 'audits:read'] }],
    },
  ],
})
for (const line of (await auth.start?.()) ?? []) console.log(line)
```

## Public API

- `usersAuth(options): AuthProvider` — see `UsersAuthOptions` and `OidcProviderOptions` in
  `src/options.ts`. `origin` is the public origin of the web UI: its hostname is the WebAuthn
  relying party id and links point to `${origin}/link/<token>`. Defaults: `rpName` `Holtkeeper`,
  sessions 12 h, links 72 h, secure cookies when `origin` is https.
- `start()` — with `bootstrap` set and an empty store, creates the first admin and returns one log
  line with the enrollment link. Otherwise `[]`.
- `bootstrapUsers({ store, origin, name, email?, linkTtlHours?, now? })` — the same without a
  provider. Creates a root user (`*` on everything) when there are no users and returns
  `{ link, expiresAt }`. While that bootstrap user is the only user and has no passkey, every call
  issues a fresh link, so losing the startup log does not lock the instance. Otherwise `undefined`.
- Types `UserView`, `UserList`, `LinkResponse`, `LinkInfo`, `ExternalAccountView`,
  `ExternalAccountList` — structurally identical to those in `@holtkeeper/api`; `ForgeIssuer` for
  `forges`.

## Flows

**Passkey login** — discoverable credentials, no username. `POST /passkey/login/options` returns
WebAuthn request options and sets `hk_webauthn` (signed, 5 minutes) with the challenge.
`POST /passkey/login/verify { response }` looks the credential up by id, checks the user handle,
verifies the assertion against the cookie's challenge, stores the new counter and `lastUsedAt`,
and sets the session cookie.

**Enrollment and recovery links** — admins invite users (`enroll`) or issue `recover` links. The
holder opens `/link/<token>` in the web UI, which calls `GET /link/:token` for `LinkInfo`, then
`POST /link/:token/register/options` and `POST /link/:token/register/verify { response, label? }`.
The registration challenge cookie is bound to the link's token hash. A successful registration
stores the passkey (users may hold several), marks the link used and signs the holder in. A
recovery link also bumps the user's `sessionVersion`, which ends every other session.

**Own passkeys** — a signed-in user reads their account with `GET /me` (a `UserView`) and manages
their passkeys there: `POST /me/passkeys/options` and `POST /me/passkeys/verify { response, label? }`
register another one (the challenge cookie is bound to the user id and excludes passkeys they already
have), `PATCH /me/passkeys/:id { label }` renames one and `DELETE /me/passkeys/:id` removes one. The
only passkey cannot be removed (409): that would lock the account; an admin can still delete it.

**OIDC** — `GET /oidc/:id/login` redirects to the provider with authorization code + PKCE (S256),
`state` and `nonce`; all three secrets live in `hk_oidc` (signed, 10 minutes). The provider
redirects to `${origin}/auth/users/oidc/:id/callback`; register that URL with the provider. On
callback:

1. A known identity (issuer id + subject) signs in its user.
2. Otherwise a **verified** email that matches an existing user links the identity to that user.
3. Otherwise, with `allowSignup` and (when `emailDomains` is set) a verified email in one of those
   domains, a new user with `defaultGrants` is created.
4. Otherwise 403.

Success redirects to `/` with the session cookie.

**External accounts** — with `externalAccounts` set (usually `store.externalAccounts`), admins
link forge or chat ids to users they manage: `POST /admin/users/:id/accounts { provider,
externalId, username? }` stores a link verified by `admin` (GitLab and GitHub ids must be
numeric). A link the user already has is upgraded, an unverified link of someone else is
replaced, a verified link of someone else answers 409. Listing needs only visibility of the user.
OIDC sign-ins also link: when an OIDC provider has `linkAccounts: 'gitlab:work'`, or its
`issuer` equals the URL of a GitLab entry in `forges`, every sign-in records the ID token's
`sub` (GitLab's numeric user id) and `preferred_username` as a verified `oidc` link — never
taking a verified link away from another user. See
[@holtkeeper/identities](../../identities/docs/README.md) for what the levels mean.

```ts
usersAuth({
  store: store.users,
  externalAccounts: store.externalAccounts,
  forges: [{ id: 'work', kind: 'gitlab', url: 'https://gitlab.example.com' }],
  oidc: [{ id: 'gitlab', label: 'GitLab', issuer: 'https://gitlab.example.com' /* ... */ }],
  // ...
})
```

`UserView.avatarUrl` is `/api/avatars/<avatarSeed or id>.svg`, rendered by the server.

**Sessions** — `hk_session` carries `{ uid, v }`, HMAC-signed with `sessionSecret`. `authenticate`
returns a principal only for an existing, enabled user whose `sessionVersion` equals `v`.
`POST /logout` clears the cookie on this device.

## Routes

Relative to `/auth/users`. Errors are `{ error }` JSON: 400 invalid input or expired challenge,
401 not signed in or failed verification, 403 forbidden, 404 unknown, 405 wrong method, 409
duplicate email or passkey, 410 used or expired link.

| Method | Path                                   | Result                               |
| ------ | -------------------------------------- | ------------------------------------ |
| POST   | `/passkey/login/options`               | WebAuthn request options             |
| POST   | `/passkey/login/verify`                | 204 + session cookie                 |
| GET    | `/link/:token`                         | `LinkInfo`                           |
| POST   | `/link/:token/register/options`        | WebAuthn creation options            |
| POST   | `/link/:token/register/verify`         | 204 + session cookie                 |
| GET    | `/oidc/:id/login`                      | 302 to the provider                  |
| GET    | `/oidc/:id/callback`                   | 302 to `/` + session cookie          |
| POST   | `/logout`                              | 204, cookie cleared                  |
| GET    | `/me`                                  | `UserView` of the caller             |
| POST   | `/me/passkeys/options`                 | WebAuthn creation options            |
| POST   | `/me/passkeys/verify`                  | 201 `UserView`                       |
| PATCH  | `/me/passkeys/:passkeyId`              | `UserView`                           |
| DELETE | `/me/passkeys/:passkeyId`              | 204                                  |
| GET    | `/admin/users`                         | `UserList`                           |
| POST   | `/admin/users`                         | 201 `LinkResponse` (enrollment link) |
| PATCH  | `/admin/users/:id`                     | `UserView`                           |
| POST   | `/admin/users/:id/recovery`            | 201 `LinkResponse` (recovery link)   |
| DELETE | `/admin/users/:id/passkeys/:passkeyId` | 204                                  |
| GET    | `/admin/users/:id/accounts`            | `ExternalAccountList`                |
| POST   | `/admin/users/:id/accounts`            | 201 `ExternalAccountView` (`admin`)  |
| DELETE | `/admin/users/:id/accounts/:accountId` | 204                                  |

## Permission rules

A global admin holds every action on everything (`grantsWithin(root, caller.grants)`).

- **See** a user: global admin, or `users:read` and the user's grants are within the caller's.
  Users the caller cannot see answer 404 everywhere.
- **Invite**: `users:invite` and `canDelegate(caller, grants)`.
- **Manage** (patch, recovery link, delete passkey, link or unlink accounts): global admin, or `users:write` and the
  target's current grants are within the caller's. New grants additionally need `canDelegate`.
- Nobody changes their own grants or disables themselves.
- Changing grants or disabling bumps `sessionVersion`, so the change applies immediately.

Activity events (when `activity` is given): `user.invited`, `user.updated`, `user.disabled`,
`user.enabled`, `user.recovery_issued`, `user.recovered`, `user.login`, `user.signed_up`,
`passkey.registered`, `passkey.renamed`, `passkey.removed`, `identity.linked`, `account.linked`, `account.unlinked`.

## Security notes

- Link tokens are 32 random bytes (base64url); only their SHA-256 hash is stored. Links are single
  use and expire. A link of a disabled user answers 403.
- WebAuthn requires user verification and resident keys; attestation is `none`. Challenges are not
  kept on the server; they live in a signed 5-minute cookie bound to the flow (and to the link for
  registration). The library rejects counter regressions.
- Session, WebAuthn and OIDC cookies are signed with keys derived per purpose, so one cannot stand
  in for another. All are `HttpOnly; SameSite=Lax`, `Secure` on https.
- Write requests with an `Origin` header other than `origin` are rejected with 403.
- OIDC email linking and sign-up trust only `email_verified` claims.
- Logout only clears the local cookie; to end every session, disable the user or issue recovery.
- No rate limiting here; put the server behind something that limits login attempts.

## Replaceable parts

`createUsersAuth(options, { webauthn, oidcClient })` in `src/provider.ts` takes a `WebAuthn`
(`src/webauthn.ts`, default `@simplewebauthn/server`) and an `OidcClientFactory`
(`src/oidc-client.ts`, default `openid-client` with discovery). Tests use fakes for both.

## Limits

`UserStore` has no way to list a user's identities, so `UserView.identities` stays empty unless the
store also implements `listIdentities(userId)`, which is used when present.
