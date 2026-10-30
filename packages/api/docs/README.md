# @holtkeeper/api

The HTTP contract between the server and its clients (web UI, CLI): request and response types for every endpoint, plus small pure helpers both sides use. It contains no server code and is safe to bundle for browsers.

## Helpers

- `summarizeRun(run)` — the numbers lists and charts show: active findings by severity, fixed, allowlisted, expired allowlist entries, changed files, and the languages and package managers involved.
- `sourceInfo(source)` — which package manager and language a finding's file belongs to (`pnpm-lock.yaml` → pnpm / JavaScript, `go.mod` → Go modules / Go, `uv.lock` → uv / Python, ...). This is what makes reports look the same for every ecosystem.

## Endpoints

| Endpoint                                                                                             | Types                                                                                |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `GET /api/me`                                                                                        | `MeResponse`                                                                         |
| `GET /api/repos`                                                                                     | `RepoList`                                                                           |
| `GET /api/audit-runs?repo=&before=&limit=`                                                           | `AuditRunList`                                                                       |
| `GET /api/audit-runs/:id`                                                                            | `AuditRunDetail`                                                                     |
| `POST /api/audit-runs`                                                                               | `IngestAuditRun` → `AuditRunDetail`                                                  |
| `GET/POST /api/credentials`, `PATCH/DELETE /api/credentials/:id`, `POST /api/credentials/:id/rotate` | `CredentialList`, `CreateCredentialInput`, `UpdateCredentialInput`, `CredentialView` |
| `GET/PUT /api/settings`, `DELETE /api/settings/:id`, `GET /api/settings/resolve?repo=`               | `SettingList`, `PutSettingInput`, `SettingView`, `ResolvedSettings`                  |
| `GET /api/activity`                                                                                  | `ActivityList`                                                                       |
| `/auth/users/admin/users...`                                                                         | `UserList`, `InviteUserInput`, `UpdateUserInput`, `LinkResponse`, `LinkInfo`         |

Errors are `ApiError { error }` with status 400, 401, 403, 404 or 500.
