# @holtkeeper/auth-none

`noAuth({ name? })` — no sign-in. Every request is the root user with every permission.

Use it for local runs or when Holtkeeper is reachable only from a trusted network. Never expose it publicly; put [`auth-header`](../../auth-header/docs/README.md) behind a proxy or use [`auth-password`](../../auth-password/docs/README.md) instead.
