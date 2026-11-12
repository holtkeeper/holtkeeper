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

## Daily storage snapshot

A leader duty (`periodicDuty('storage snapshot', …)` in `startServer`) measures `storageOverview` at start and every 6 hours and records it with `recordStorageSnapshot` under the kv key `storage:history`: one point per UTC day (`day`, `bytes`, `areas` by provider id, unavailable areas left out), the latest measurement of the day winning, 90 days kept. `weekAgoSnapshot(history, now)` picks the point the health endpoint compares against. Stores without `kv` record nothing and report no weekly change.

## `periodicDuty`

`periodicDuty(name, task, { intervalMs, log })` from `src/leader.ts` turns a task into a `LeaderDuty`: it runs at once and every `intervalMs` while the process leads, runs never overlap, and a failure is logged as `<name>: run failed: …` without stopping the next run. The storage snapshot and the audit chain check ([Audit log](audit-log.md)) use it.
