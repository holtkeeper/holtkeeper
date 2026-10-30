# @holtkeeper/auth-password

One root user behind a password.

```ts
passwordAuth({
  password: env('HOLTKEEPER_PASSWORD'),
  sessionSecret: env('HOLTKEEPER_SESSION_SECRET'),
})
```

| Option                 | Default                                                    |
| ---------------------- | ---------------------------------------------------------- |
| `password`             | required                                                   |
| `sessionSecret`        | required, at least 32 characters                           |
| `name`                 | `root`                                                     |
| `sessionTtlHours`      | 12                                                         |
| `secureCookies`        | `true` (set `false` only for plain-HTTP local development) |
| `maxFailuresPerMinute` | 5; further attempts get `429` for a minute                 |

Endpoints: `POST /auth/password/login { password }` → `204` with a session cookie, `401` on a wrong password; `POST /auth/password/logout`.

The session carries a fingerprint of the password, so changing the password signs everyone out. The throttle is per process; put a rate limit at the proxy for stronger protection.
