# @holtkeeper/auth-header

Users and their permissions come from HTTP headers set by an authenticating reverse proxy: oauth2-proxy, Authelia, Pomerium, Cloudflare Access, Traefik forward auth, and similar.

```ts
headerAuth({
  proxySecret: { header: 'x-holtkeeper-proxy', value: env('PROXY_SECRET') },
  roles: {
    'keeper-admins': [{ scope: { all: true }, actions: ['*'] }],
    'games-team': [
      { scope: { groups: ['games'] }, actions: ['audits:read', 'audits:run', 'settings:read'] },
    ],
  },
  defaultGrants: [{ scope: { all: true }, actions: ['repos:read'] }],
})
```

| Option                            | Default                                                          |
| --------------------------------- | ---------------------------------------------------------------- |
| `userHeader`                      | `x-forwarded-user` (required; requests without it are anonymous) |
| `nameHeader`                      | `x-forwarded-preferred-username`                                 |
| `emailHeader`                     | `x-forwarded-email`                                              |
| `groupsHeader`, `groupsSeparator` | `x-forwarded-groups`, `,`                                        |
| `roles`                           | proxy group → grants                                             |
| `defaultGrants`                   | grants every identified user gets                                |
| `grants(identity)`                | replaces `roles` and `defaultGrants` for custom mapping          |
| `proxySecret`                     | header with a shared secret the proxy adds                       |

## Security

Holtkeeper believes these headers, so:

- the proxy must remove them from incoming client requests;
- Holtkeeper must not be reachable around the proxy. `proxySecret` enforces that: without the secret header (compared in constant time) every request is anonymous.

Principal ids are `header:<user>`. There are no sessions and no logout here; both belong to the proxy.
