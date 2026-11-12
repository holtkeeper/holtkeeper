# System

Part of the [@holtkeeper/server](README.md) docs.

Server side of Settings › System: health at a glance with the storage change over seven days, plus the endpoints the README describes: [Storage](README.md#storage), [Database](README.md#database), [Egress cache](README.md#egress-cache) and the library index admin routes.

## `GET /api/system/health`

Global `settings:read`. Answers `SystemHealth` (`@holtkeeper/api`, `settings-system.ts`), measured on request by `systemHealth(deps, { startedAt })` in `src/health.ts`; every check fails after 3 seconds.

| Check               | When it is listed                          | Status                                                                                                                       |
| ------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `store`             | always                                     | `error` when a one-row job query fails, else `ok` (`answering`)                                                              |
| `migrations`        | stores with `ready()` (Postgres)           | `error` when migrations are not applied, else `ok` (`up to date`)                                                            |
| `artifacts`         | an artifact store is configured            | `error` when `ping()` fails                                                                                                  |
| `workers`           | stores with `kv`                           | `warn` when no worker reported its disks in 15 minutes, else `N workers reporting`                                           |
| `library-index`     | the `libraries` setting is on              | `ok` while indexing (`indexing 142 of 412`) or idle; `warn` while waiting for GitHub quota or after a failed run             |
| `retired-read-only` | stored `repo.readOnly: true` entries exist | `warn`: those entries no longer stop writes and have to be set again as `repo.freeze`; the server also logs it once at start |

`status` is the worst check. `storage.totalBytes` is the same total as `GET /api/storage` (`storageOverview` in `src/storage.ts`, shared by both routes). `storage.since`, `weekAgoBytes` and `weekAgo` (bytes per area id) come from the newest daily snapshot at least seven days old and are absent until one exists. `workers` counts fresh worker reports, `version` is `ServerDeps.version` or `HOLTKEEPER_VERSION`, trimmed and left out when empty (`releaseVersion`, shared with `GET /api/me`), `startedAt` when the routes were built.

`artifactStore` (`ArtifactStoreView`, `artifactStoreView` in `src/health.ts`) is present when the artifact store has a `location` (fs and S3, not memory): `kind`, the S3 `endpoint` host (no scheme, user info or path; absent for AWS), `bucket`, `region` and `prefix` or the fs `dir`, never keys. `usedBytes` and `objects` come from the store's `usage()` (cached for a minute on S3 and shared with the storage overview's measurement, so the route lists the bucket at most once): on S3 every object under the prefix (artifacts, sidecars, refs) as the listing saw it, else the artifacts. `quotaBytes` is `server.artifacts.quotaBytes`, a figure the operator declares (S3 has no quota API); `retention` is `server.retention`, absent when artifacts are kept forever. A measurement that fails or passes the timeout leaves out the figures and sets `error`; reachability stays the `artifacts` check.

## Daily storage snapshot

A leader duty (`periodicDuty('storage snapshot', …)` in `startServer`) measures `storageOverview` at start and every 6 hours and records it with `recordStorageSnapshot` under the kv key `storage:history`: one point per UTC day (`day`, `bytes`, `areas` by provider id, unavailable areas left out), the latest measurement of the day winning, 90 days kept. `weekAgoSnapshot(history, now)` picks the point the health endpoint compares against. Stores without `kv` record nothing and report no weekly change.

## `periodicDuty`

`periodicDuty(name, task, { intervalMs, log })` from `src/leader.ts` turns a task into a `LeaderDuty`: it runs at once and every `intervalMs` while the process leads, runs never overlap, and a failure is logged as `<name>: run failed: …` without stopping the next run. The storage snapshot and the audit chain check ([Audit log](audit-log.md)) use it.

## Subgroups

A subgroup (`shapes.round`, see [@holtkeeper/core](../../../packages/core/docs/README.md#subgroups)) holds only repositories of its parent, so the server treats root groups as the source of membership:

- **Webhooks.** `defaultWebhookTargets` skips subgroups: the parent's hooks already reach their members, and exact paths in a subgroup's include would otherwise add project hooks on top of the parent's group hook and deliver every event twice.
- **Listing.** Polling lists root groups only (`listedRepos`, the poller's known repositories and the new-repository check). `GET /api/repos/updates/groups/<subgroup>` answers the parent's stored listing narrowed to the subgroup (`parent` set, `matched` = every parent member, the candidates its patterns pick from; `attempts` only with `settings:read` on the parent) without calling the forge; `POST …/list` on a subgroup lists the parent and needs `settings:write` on the parent too.
- **Defaults.** Freshness gives group-scope analyzers a target per group, subgroups included, so a subgroup's Stack tab fills on its own. Schedules without `groups`, release overviews and analysis backfills without a group, and the exact include paths on Home use root groups, so nothing runs or counts twice.
- **Panel config.** `PUT /api/config/groups/<id>` takes `groupIdSchema` ids (one optional dot); the group listing sets `parent` on subgroups. `DELETE` of a group that still has subgroups answers 409 naming them (`delete subgroups first: …`).
- **Access and titles.** A group analysis target `{ path: <subgroup> }` belongs to the subgroup and its parent (`groupLineage`). `reachableGroups` (the titles in `GET /api/me`) holds the groups named in the principal's grants with their subgroups, the innermost groups of every repository it can list, and the parents of all of them; a grant on one subgroup never reveals its siblings. `GET /api/settings/resolve?group=<subgroup>` resolves for the subgroup and its parent, so parent entries show as inherited and the subgroup's own entries win.
