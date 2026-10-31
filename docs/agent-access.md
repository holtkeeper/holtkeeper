# Agent access

An AI agent with a browser can drive the web UI like any user: open pages, run analyses, edit settings. It gets there through its own account and a single-use login link, so it never needs a passkey and every action it takes is attributed to it in the activity log.

This needs `users` sign-in (`HOLTKEEPER_AUTH=users`, see [@holtkeeper/auth-users](../packages/auth-users/docs/README.md)) and `server.publicUrl`. The commands run wherever the config and its secrets are, which makes whoever runs them an operator: they skip the delegation checks of the web UI. Full reference: [`holtkeeper users`](../apps/cli/docs/README.md#users-action).

## 1. Create the account

Once per instance:

```sh
holtkeeper users add Claude --admin
```

`--admin` grants every action on everything. Without it the account has no grants; give it narrower ones in the web UI. `holtkeeper users list` shows who exists.

## 2. Issue a login link

Each time the agent needs a session:

```sh
holtkeeper users login-link Claude --ttl 15m
```

It prints `https://<publicUrl>/auth/users/link/<token>/login`. The link works once and only until it expires (`15m` by default). Treat it like a password: hand it straight to the agent's browser and keep it out of chats, logs and tickets.

In Kubernetes, run the command in a web pod, which has the config and the store's secrets:

```sh
kubectl -n holtkeeper exec deploy/holtkeeper-web -- \
  holtkeeper users login-link Claude -c /app/config/holtkeeper.config.ts
```

## 3. Open it in the agent's browser

Opening the link sets the session cookie and redirects to `/`. From then on the agent is signed in for 12 hours on that browser, and `GET /api/me` returns its principal. That is the quickest check that the session works. The same cookie authenticates the JSON API, so `fetch('/api/...')` from the page works too.

A used or expired link answers 410: issue a new one. Login links never register passkeys, and enrollment links cannot sign in.

## Audit and revocation

- The activity log records `user.invited` and `user.link_issued` with actor `cli`, then `user.login` (method `link`) and everything the agent does under its own user id.
- To end the agent's sessions, disable the account or change its grants in the web UI. Both bump its `sessionVersion`, so existing cookies stop working at once. Links of a disabled user answer 403.
- `POST /auth/users/logout` ends the session on that browser only.
