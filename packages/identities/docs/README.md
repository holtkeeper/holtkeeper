# @holtkeeper/identities

External accounts — GitLab and GitHub users, Slack members, anything with a stable id — linked to Holtkeeper principals, and the one question bots and webhooks need answered: _who is this external actor in Holtkeeper, and may they do this?_

Links live in `store.externalAccounts` (see [@holtkeeper/store](../../store/docs/README.md)). An `ExternalAccount` is `{ id, userId, provider, externalId, username?, verification, linkedBy, linkedAt, verifiedAt? }`, unique by `(provider, externalId)`. `userId` is the Holtkeeper principal id: the user id with the `users` auth provider, the provider's principal id otherwise (`header:jane`, `root`, ...).

Provider ids: `gitlab:<forgeId>`, `github:<forgeId>` (`forgeProvider(kind, forgeId)`), `slack:<workspaceId>` (`slackProvider(id)`), or any `kind[:instance]`. GitLab and GitHub accounts are linked by **numeric user id**, never by username: usernames can be renamed and reused, ids cannot.

## Verification levels

| Level        | Set by                                                                                  | Authorizes |
| ------------ | --------------------------------------------------------------------------------------- | ---------- |
| `admin`      | someone with `users:write` over the user (`POST /auth/users/admin/users/:id/accounts`)  | yes        |
| `oidc`       | signing in through an OIDC provider that is that forge (GitLab `sub` = numeric user id) | yes        |
| `challenge`  | the user posted their one-time code from that account (`/holtkeeper verify <code>`)     | yes        |
| `unverified` | the user typed the id themselves (`POST /api/accounts`)                                 | **never**  |

**Why unverified links never authorize.** Anyone can type any number. If a self-claimed link counted, a developer could claim a maintainer's GitLab id and have the bot treat their MR commands as the maintainer's — or, the other way round, claim their own id under a more privileged Holtkeeper account. A link only counts once someone with authority over the user vouched for it (admin), the identity provider proved it (OIDC), or the person proved control of the external account by posting a secret code from it (challenge). Until then, `resolveExternalActor` returns nothing and `authorizeExternal` says `unverified`.

Because unverified links prove nothing, they also do not block: when someone else links the same `(provider, externalId)`, an unverified link is taken over (the earlier claimant loses it and its pending code). A verified link is never taken over by self-service; an admin must unlink it first.

## Challenge flow

1. The user links their id: `POST /api/accounts { provider: 'gitlab:work', externalId: '42' }` → `unverified`.
2. `POST /api/accounts/:id/challenge` → `{ code: 'K7QD-2M9X', expiresAt, command: '/holtkeeper verify K7QD-2M9X' }`, shown once. Codes are 8 Crockford base32 characters (40 bits), valid 30 minutes, stored only as SHA-256 bound to the account id; a new challenge replaces the old one.
3. The user posts the command as a GitLab MR or issue comment, or sends it to the Slack bot.
4. The webhook or bot extracts the code with `parseVerifyCommand(text)` and calls `completeChallenge({ provider, externalId, username, code })` with the **author id from the authenticated event** — never from the comment text.
5. A match turns the link into `challenge` with `verifiedAt` and the reported `username`. Five wrong codes or expiry drop the challenge. Every answer is appended to the audit log as `account.verify` (`ok` or `denied`, `via: 'webhook'` unless given).

`ChallengeResult` is `{ ok: true, account }` or `{ ok: false, reason }` with `not-linked`, `already-verified`, `no-challenge`, `expired`, `wrong-code`, `too-many-attempts`, for the bot's reply.

## Public API

- `createIdentities({ accounts, users?, principalFor?, audit?, challengeTtlMinutes = 30, maxChallengeAttempts = 5, maxLinksPerUser = 20, now? }): Identities`
  - `list(principal)`, `link(principal, input)`, `unlink(principal, id)`, `issueChallenge(principal, id)` — self-service; throw `IdentityError` with `code` `invalid | forbidden | not-found | conflict`.
  - `completeChallenge(answer)` — see above.
  - `resolveExternalActor({ provider, externalId }) → Principal | undefined` — only verified links; the principal is the stored user with its **current** grants (disabled or deleted users → `undefined`).
  - `authorizeExternal({ provider, externalId, action, repo }) → { allowed, principal?, reason }` with `reason` `allowed | not-linked | unverified | no-principal | forbidden`. `repo` is a `RepoTarget` (include the config groups, e.g. via the server's `repoTarget`). For MR commands and the Slack bot.
- `linkInputSchema`, `parseVerifyCommand`, `verifyCommand`, `generateChallengeCode`, `normalizeChallengeCode`, `forgeProvider`, `slackProvider`, `isVerified`.

The server builds the service with `identitiesFor(deps)` from `apps/server/src/routes/accounts.ts`.

## Auth providers without stored users

With `header`, `password` or `none` auth there is no user record to read grants from. Links of such principals keep a snapshot `{ name, provider, grants }` of the principal, refreshed every time that principal lists or manages its links; `resolveExternalActor` uses the snapshot. Grants revoked at the proxy therefore reach external actions only after the person's next visit to their accounts page — pass `principalFor` to resolve principals another way.

## Limits

- The user must know their numeric id (GitLab shows it on the profile page).
- Ping-pong over an unverified claim is possible but harmless: neither side is authorized until one verifies.
- No rate limit across accounts beyond the per-challenge attempt count; webhooks are authenticated by their secret, which is what makes the author id trustworthy.
