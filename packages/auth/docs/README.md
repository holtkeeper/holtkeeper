# @holtkeeper/auth

The contract every sign-in method implements, plus shared helpers for sessions.

## AuthProvider

```ts
interface AuthProvider {
  readonly name: string
  authenticate(request: Request): Promise<Principal | undefined>
  handle?(
    request: Request,
    path: string,
    principal: Principal | undefined,
  ): Promise<Response | undefined>
  info(): AuthInfo
  start?(): Promise<string[]>
}
```

- The server asks the configured provider who each request comes from. `undefined` means anonymous; the API answers `401` where a principal is needed.
- `handle` serves the provider's own endpoints under `/auth/<name>/` (login, callbacks, user admin). It uses plain `Request`/`Response`, so providers do not depend on the server framework.
- `info()` tells the UI which login methods to show (`password`, `passkey`, `oidc` links) and where to log out.
- `start()` runs once at server start and returns lines to log, e.g. a first-admin setup link.

## Providers

| Package                                                           | Who signs in                                                                  |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [`@holtkeeper/auth-none`](../../auth-none/docs/README.md)         | Nobody — every request is root                                                |
| [`@holtkeeper/auth-header`](../../auth-header/docs/README.md)     | Users identified by a reverse proxy through headers, grants from proxy groups |
| [`@holtkeeper/auth-password`](../../auth-password/docs/README.md) | Root behind one password                                                      |
| [`@holtkeeper/auth-users`](../../auth-users/docs/README.md)       | Real users: passkeys and OIDC, invites, recovery links, scoped grants         |

## Helpers

- `createSessionCodec(secret)` — stateless HMAC-SHA256 signed tokens with expiry for session cookies. Payloads are readable by clients; never put secrets in them.
- `readCookie`, `sessionCookie` (HttpOnly, SameSite=Lax, Secure by default), `clearCookie`.
- `safeEqual(a, b)` — constant-time comparison of secrets.
- `json(body, init)` — JSON responses for provider endpoints.
