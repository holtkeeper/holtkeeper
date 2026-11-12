# People

Part of the [@holtkeeper/server](README.md) docs.

Server side of Settings › People & access: users, invites, teams, last seen (`User.lastSeenAt`, `UserStore.touchUser`) and Reach (`access.crossTeam`). Read-only repositories are described in [Read-only repositories](README.md#read-only-repositories).

The users endpoints belong to the `users` auth provider and live under `/auth/users` (see [@holtkeeper/auth-users](../../../packages/auth-users/docs/README.md)); the server mounts them and audits every write under `/auth/users/admin/` with its audit middleware.

| Endpoint                                  | What it returns                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------ |
| `GET /auth/users/admin/users`             | `UserList`; each `UserView` with `lastSeenAt`, `invite`, `teams` and `creator` |
| `GET /auth/users/admin/summary`           | `PeopleSummary` over the users the caller may see                              |
| `POST /auth/users/admin/users/:id/invite` | 201 `LinkResponse`: a new enrollment link for someone who never signed in      |
| `GET /auth/users/me`                      | the caller's `UserView`; `creator` is the Account page's "Given by"            |

- **Last seen** — the provider's `authenticate` moves `lastSeenAt` at most once a minute per user, so every signed-in request through the server counts.
- **Teams and invites** — need the provider's `kv` option (`kv: store.kv` in the config): teams read the home groups `PUT /api/me/preferences` stores under `prefs:<id>`, invites are remembered under `users:invite:<id>`. Without it teams fall back to the groups in the grants and there are no invite states.
- **Activity** — a person's sheet reads `GET /api/history?actor=<id>`, with the Audit log's visibility rules; there is no separate activity endpoint.
- **Reach** — `access.crossTeam` is one global level (`off`, `metadata`, `snippets`) without per-team exceptions; `GET /api/me` returns it as `crossTeam`.
