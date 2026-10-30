# @holtkeeper/store

The persistence contract. Everything Holtkeeper stores goes through `Store`; implementations are interchangeable.

| Part               | Holds                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `auditRuns`        | Finished audit runs with full reports, newest first, filterable by repository                                                  |
| `credentials`      | Forge accounts, API keys and AI providers; `secret` is always sealed by a `Vault`, kind-specific `options` are stored as given |
| `settings`         | Scoped setting entries (see [@holtkeeper/settings](../../settings/docs/README.md))                                             |
| `users`            | Users, passkeys, OIDC identities and one-time link tokens (only hashes)                                                        |
| `activity`         | Who did what: logins, credential and setting changes, ingested audits                                                          |
| `jobs`             | The task queue for background analyses (see below)                                                                             |
| `knowledge`        | Knowledge base entries with version history and search (see below)                                                             |
| `aiUsage`          | One record per LLM agent run: tokens, cost, outcome (see below)                                                                |
| `ciJobs`           | Finished CI job attempts per repository, kept so job analytics fetch only what is new (see below)                              |
| `audit`            | Optional. The append-only, hash-chained audit log (see below)                                                                  |
| `externalAccounts` | Optional. External accounts (GitLab, GitHub, Slack ids) linked to principals (see below)                                       |

## Jobs

`JobStore` is the queue of [@holtkeeper/jobs](../../jobs/docs/README.md). A `Job` is one analyzer run for one repository (or one config group: `repo` is `{ forge, path: <group> }` and `group` is set) with `status` `queued | running | succeeded | failed | canceled`.

- `enqueue` — defaults: `maxAttempts` 3, `runAfter` = `createdAt`, empty `options` and `log`.
- `claim(workerId, now)` — atomically takes the oldest due queued job whose repository has no running job, marks it running and counts the attempt.
- `heartbeat(id, workerId, now)` — `false` once the job is no longer running for that worker (e.g. canceled).
- `complete`, `fail(id, { at, error, retryAt? })` (back to the queue while attempts remain and `retryAt` is given), `cancel`, `recoverStale(heartbeatBefore, at)` for jobs of dead workers.
- `list({ status, repo, analyzer, before, limit })` newest first; `appendLog` keeps the last `JOB_LOG_LIMIT` (200) lines.

## Knowledge

`KnowledgeStore` holds the entries of [@holtkeeper/knowledge](../../knowledge/docs/README.md).

- `put(entry)` — upsert by id. The store assigns `version` (1, then +1 per put) and moves the previous version into the history with `editedBy` (its `updatedBy`, or `author`) and `editedAt` (its `updatedAt`).
- `get(id)`, `history(id)` (previous versions, newest first), `remove(id)` (drops the history too).
- `list(filter)` — most recently updated first. `KnowledgeFilter`: `status` and `kind` (one or a list), `topic` (exact, case-insensitive), `scope` (substring of a group or repo pattern; `all` matches scopes covering everything), `package` (`react` or `npm:react`).
- `search(text, filter, limit = 20)` → `{ entry, score }[]`, best first. Every word of `text` is a prefix (`migr` finds `migration`), any word may match, title matches outrank topic/package matches, which outrank body matches. Quotes, operators and punctuation are plain text; blank text returns nothing. Scores are only comparable within one result.

`knowledgeWords` and `matchesKnowledgeFilter` are exported for implementations.

## AI usage

`AiUsageStore` is the history behind [@holtkeeper/ai-usage](../../ai-usage/docs/README.md). An `AiUsageRecord` holds the repository and the groups it had at the time, task kind, analyzer/job/analysis ids, actor, provider, model, the four token counts, `costUsd` with `costSource` (`reported | computed | unknown`), duration, turns and `outcome` (`ok | error | denied-budget`).

- `append(record)`; `list({ ...filter, before, limit })` newest first.
- `aggregate({ from, to, groupBy, filter })` — one bucket per distinct combination of `groupBy` values (`day`, `week` = its Monday, `month`, all UTC; `repo` as `forge:path`, `group`, `model`, `provider`, `taskKind`, `analyzer`), sorted by key. Each bucket sums tokens per kind and cost and counts `runs`, `errors`, `denied`, with `avgDurationMs` over runs that were not denied. A record in several groups counts once per group; records without groups (or analyzer) fall under `''`. No matching records, no buckets.
- `AiUsageFilter`: `from` (inclusive), `to` (exclusive), `repo`, `group`, `model`, `provider`, `taskKind`, `analyzer`, `outcome`, and `scopes` — records covered by any of them (an empty list matches nothing), used for access filtering and scoped budgets.

## CI jobs

`CiJobStore` keeps finished CI job attempts (`CiJobRecord`: repository, job and pipeline ids, name, stage, `success | failed | canceled`, ref, sha, times, duration and queue seconds, `allowFailure`, link) for [@holtkeeper/ci-jobs](../../ci-jobs/docs/README.md).

- `put(records)` inserts or replaces by repository and job id; times are stored in the contract's ISO 8601 form (`normalizeCiJob`).
- `list(repo, { from?, to? })` — created in `[from, to)`, oldest first, ties by job id (`compareCiJobs`).
- `coverage(repo)` — oldest and newest creation time and count; `undefined` without records.
- `prune(before)` — removes records of every repository created before `before`, returns how many.

`aggregateAiUsage`, `matchesAiUsageFilter`, `aggregateFilter`, `sortAiUsageBuckets`, `weekStart`, `aiUsageDimensions` and `emptyAiUsageTotals` are exported for implementations.

## Config documents and key-value state

Both are optional parts of `Store`; servers without them use the file config only and keep such state in memory.

- `config` (`ConfigStore`) holds panel-managed configuration as typed documents: `forge`, `group`, `repoTraits`, `schedule`, `trigger` (shapes in `ConfigDocumentDataMap`, see [@holtkeeper/managed-config](../../managed-config/docs/README.md)). `put` creates or replaces by `(type, id)`, bumps `version` and keeps the previous version in `history(type, id)` (newest first); `list(type?)` orders by type, then id; `remove` drops the document and its history.
- `kv` (`KvStore`) is small JSON state with optional expiry: `get`, `set(key, value, ttlSeconds?)`, `delete`, and `sweep(now?)` removing expired keys. Expired keys read as missing even before a sweep. Merge request policies remember done actions here. Two atomic operations make it usable by several processes: `acquireLease(key, holder, ttlSeconds, now?)` takes or renews a lease (granted when none is live at `now` or `holder` already has it; resolves with the lease as it is afterwards) and `releaseLease(key, holder)`; `compareAndSet(key, expected, value, ttlSeconds?)` writes only over the expected value (JSON equality, key order ignored, `undefined` = missing). The server's leader election and the distributed limiter use them; memory, SQLite and Postgres implement them (they are optional in the contract for third-party stores).

## Audit log

`AuditStore` (`store.audit`) is the tamper-evident record of who changed what. It is separate from `activity`, which stays the human-readable feed. An `AuditEvent` is `{ id, seq, at, actor { id, name, provider }, via: ui | api | webhook | job | system, action, target { type, id?, repo? }, outcome: ok | denied | error, status?, request? { method, path, route?, params?, ip?, userAgent?, durationMs? }, changes? { field, before?, after? }[], details?, prevHash, hash }`. Secret values in `changes` are `«redacted»` before they reach the store.

- `append(input)` — the store assigns `id`, `seq` (one more than the newest event ever appended; never reused, not even after a sweep) and the chain: `prevHash` is the previous event's `hash` (64 zeros for `seq` 1), `hash` the SHA-256 of `canonicalJson` of every other field (keys sorted, `undefined` dropped). Appends are serialized.
- `list({ ...filter, cursor, limit = 50 })` → `{ events, nextCursor? }`, newest first by `seq`; pass `nextCursor` back as `cursor`.
- `count(filter)`; `export(filter)` — an async iterable, oldest first, read in batches of `AUDIT_EXPORT_BATCH` (500); `formatAuditEvents(events, 'csv' | 'ndjson')` turns it into text chunks (CSV cells starting with `= + - @` are prefixed with `'` against formula injection).
- `AuditFilter`: `actor` (id), `action` (prefix: `credential` matches `credential.update`), `targetType`, `targetId`, `repo` (exact `forge:path`), `outcome`, `via`, `from` (inclusive), `to` (exclusive).
- `sweep(before)` — retention. Removes the oldest events up to the first one at or after `before`, so the kept events stay one contiguous chain even when `at` is not monotonic. Returns how many it removed; the store remembers the last swept `seq`.
- `verifyChain({ fromSeq?, toSeq? })` → `{ ok, checked, firstSeq?, lastSeq?, broken? }`. Every `seq` from the requested start (or the first unswept one) to the requested end (or the newest appended) must be present once, hash to its `hash` and link to the hash before it. `broken.reason`: `hash` (content edited), `link` (re-hashed or inserted event), `gap` (event removed from the middle or start), `tail` (newest events removed).

What the chain does and does not prove: anyone who edits the database without also recomputing every later hash and the stored chain head is caught. Someone with full write access who rewrites the whole chain and the head is not — export the log regularly (or record `hash` of the newest event elsewhere) to anchor it.

`canonicalJson`, `auditHash`, `sealAuditEvent`, `verifyAuditEvents`, `auditVerifyRange`, `matchesAuditFilter`, `auditCursorSeq` and `AUDIT_GENESIS_HASH` are exported for implementations.

## External accounts

`ExternalAccountStore` (`store.externalAccounts`) holds the links of [@holtkeeper/identities](../../identities/docs/README.md): `get`, `find(provider, externalId)`, `listByUser(userId)` and `list(provider?)` (oldest link first), `put` (upsert by id; rejects with `ExternalAccountConflictError` when another id holds the same `(provider, externalId)`) and `remove`. `removeUser` also removes the user's links. `User.avatarSeed` (optional) overrides the user id as the seed of the generated avatar.

## Implementations

- `memoryStore()` from `@holtkeeper/store/memory` — in process memory, for tests and throwaway runs.
- [`sqliteStore({ path })`](../../store-sqlite/docs/README.md) from `@holtkeeper/store-sqlite` — the default for real use.

## Contract tests

`describeStoreContract(name, create)` from `@holtkeeper/store/testing` is the behavior every implementation must have: ordering, filters, limits, upserts, cascades, round-tripping nested data. A new implementation (Postgres, ...) is done when it passes this suite unchanged.
