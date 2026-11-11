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
| `GET /api/dependencies`                                                                              | `DependencyTable`                                                                    |
| `GET /api/dependencies/library?ecosystem=&name=`                                                     | `DependencyDetail`                                                                   |
| `GET /api/dependencies/upgrade?ecosystem=&name=&from=&to=`                                           | `DependencyUpgrade`                                                                  |
| `GET /api/dependencies/docs?q=&ecosystem=&name=`                                                     | `LibrarySearchResult`                                                                |
| `GET /api/stack`                                                                                     | `StackOverview` (`StackGroupView`, `StackTool`, `StackUse`, `StackConventionResult`) |
| `GET /api/system/library-index`, `POST /api/system/library-index/reindex`                            | `LibraryIndexStatus`, `LibraryReindexResult`                                         |
| `GET /api/system/library-index/github`                                                               | `GitHubTokenUsage`                                                                   |
| `GET /api/ci`                                                                                        | `CiOverview`                                                                         |
| `GET /api/ci/repo?repo=`                                                                             | `CiRepoView`                                                                         |
| `GET /api/audit-runs?repo=&before=&limit=`                                                           | `AuditRunList`                                                                       |
| `GET /api/audit-runs/:id`                                                                            | `AuditRunDetail`                                                                     |
| `POST /api/audit-runs`                                                                               | `IngestAuditRun` → `AuditRunDetail`                                                  |
| `GET/POST /api/credentials`, `PATCH/DELETE /api/credentials/:id`, `POST /api/credentials/:id/rotate` | `CredentialList`, `CreateCredentialInput`, `UpdateCredentialInput`, `CredentialView` |
| `GET/PUT /api/settings`, `DELETE /api/settings/:id`, `GET /api/settings/resolve?repo=`               | `SettingList`, `PutSettingInput`, `SettingView`, `ResolvedSettings`                  |
| `GET /api/history`, `GET /api/history/scope`                                                         | `HistoryList`, `HistoryScope`, `PersonView`                                          |
| `/auth/users/admin/users...`                                                                         | `UserList`, `InviteUserInput`, `UpdateUserInput`, `LinkResponse`, `LinkInfo`         |
| `GET /api/home`                                                                                      | `HomeView` (`HomeAttentionItem`, `HomeChange`, `HomeSpend`, `HomeRepoTile`)          |
| `POST /api/credentials/:id/test`                                                                     | `CredentialTestInput` → `CredentialTestResult`                                       |
| `GET /api/jobs`, `GET /api/jobs/failures`, `GET /api/jobs/targets`                                   | `JobList`, `JobFailureList`, `JobTargetList`                                         |
| `GET /api/jobs/:id/why`, `GET /api/jobs/:id/log`, `GET /api/jobs/:id/runs`                           | `JobWhy`, `JobLog`, `JobRunList`                                                     |
| `GET /api/jobs/:id/transcripts/:ref`, `GET /api/chat/messages/:id/transcript`                        | `AgentTranscriptView`                                                                |
| `GET/POST /api/chat/threads`, `GET/PATCH /api/chat/threads/:id`                                      | `ChatThreadList`, `ChatThreadInput`, `ChatThreadPatchInput`, `ChatThreadView`        |
| `GET /api/chat/threads/:id/people`                                                                   | `ChatPeopleView`                                                                     |
| `GET/POST /api/chat/threads/:id/messages`                                                            | `ChatMessageList`, `ChatPostInput` → `ChatPostResult`                                |
| `POST /api/chat/threads/:id/read`, `GET /api/chat/unread`                                            | `ChatReadInput`, `ChatUnreadView`                                                    |

`RepoSummary.latestAnalyses` holds the newest record of each analysis kind when the caller may read analyses. `DependencyTable` has one row per library the caller's catalog reach uses (direct dependencies of the newest `depgraph` records and imports of the newest `usages` records), with versions per repository, latest, how far behind, advisories, licenses and Renovate state, plus the repositories with their config groups; repositories are named `forge:path`. `MeResponse.crossTeam` is the `access.crossTeam` level, so clients know whether any read grant reaches the catalog.

`ChatMessageList.cursor` is the `after` of the next poll and `serverTime` its `changedSince`; a client advances the cursor only from message pages, never from a message it posted, and expects repeated messages because `serverTime` trails the clock.

Errors are `ApiError { error }` with status 400, 401, 403, 404 or 500.
