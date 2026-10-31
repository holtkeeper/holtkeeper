# @holtkeeper/store-postgres

PostgreSQL implementation of the `Store` contract from `@holtkeeper/store`, built on Bun's built-in client (`import { SQL } from 'bun'`): tagged-template queries with bound parameters, no ORM, no extra dependencies. It passes `describeStoreContract` unchanged, so it behaves like `memoryStore` and `sqliteStore`, including the optional parts: config documents, kv, the audit log and external accounts.

Use it when several server processes share one database, or when you already run Postgres with backups and monitoring. For a single process, `@holtkeeper/store-sqlite` is simpler.

## Usage

```ts
import { defineConfig } from '@holtkeeper/core'
import { env } from '@holtkeeper/forge'
import { postgresStore } from '@holtkeeper/store-postgres'

export default defineConfig({
  // ...
  server: {
    store: postgresStore({ url: env('DATABASE_URL') }),
  },
})
```

`postgresStore(options)` returns a `PostgresStore` (a `Store` plus `ready()`):

| Option   | Default      | Meaning                                                                                                                                       |
| -------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`    | required     | `postgres://user:password@host:5432/db`, or `env('NAME')` / `{ env: 'NAME' }` to read it from the environment on first use                    |
| `schema` | `holtkeeper` | Schema holding every table. Lowercase letters, digits and `_`; created on first use if missing                                                |
| `max`    | `10`         | Pool size: the most connections this process opens                                                                                            |
| `ssl`    | from the URL | `true`, an SSL mode (`'require'`, `'verify-full'`, ...) or Bun's TLS options (`{ ca: Bun.file('ca.pem') }`). `?sslmode=` in the URL works too |

Creating the store does nothing: the URL is read, the pool opens and migrations run on the first call. Call `await store.ready()` at startup to fail fast on a wrong URL or missing rights. A failed start is retried by the next call. `close()` waits for running queries and closes the pool.

Every query names its tables with the schema (`"holtkeeper"."jobs"`), so the store does not depend on `search_path` and works behind PgBouncer. With PgBouncer in transaction mode, use version 1.21 or later with `max_prepared_statements` set; Bun uses named prepared statements.

## Local Postgres

```yaml
# docker-compose.yml
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: holtkeeper
      POSTGRES_PASSWORD: holtkeeper
      POSTGRES_DB: holtkeeper
    ports: ['5432:5432']
    volumes: ['pgdata:/var/lib/postgresql/data']
    healthcheck:
      test: ['CMD', 'pg_isready', '-U', 'holtkeeper']
      interval: 5s
volumes:
  pgdata:
```

```sh
docker compose up -d postgres
export DATABASE_URL=postgres://holtkeeper:holtkeeper@localhost:5432/holtkeeper
```

`examples/dev/holtkeeper.config.ts` has the matching `postgresStore` line as a commented alternative to SQLite.

## Rights

The role needs `CREATE` on the database to create the schema on first start, or the schema can be created beforehand (`CREATE SCHEMA holtkeeper AUTHORIZATION holtkeeper`), after which owning that schema is enough. Accent-insensitive search needs the `unaccent` extension: the first migration installs it when it can (it is a trusted extension, so a role with `CREATE` on the database may) and otherwise falls back to search without accent folding.

## Migrations

`src/migrations.ts` holds an ordered, append-only list of `{ version, sql }` steps. On start, `migrate` runs in one transaction:

1. `pg_advisory_xact_lock` on a key derived from the schema name, so processes that start together wait for each other and only the first one migrates;
2. creates the schema if it does not exist, and `schema_migrations (version, applied_at)` inside it;
3. applies every step whose version is not recorded yet, in version order (also lower versions merged after higher ones), with `search_path` set to the schema for that transaction only.

A failing step rolls back the whole run, so the schema is never half-migrated. To change the schema, append a step with the next version; never edit a released one. `migrate(sql, schema, steps?)` and `migrations` are exported for tooling.

## Schema

Columns that are filtered or sorted are real columns; nested data is `jsonb`. Timestamps are `timestamptz` and come back as `Date#toISOString()` strings (`2026-10-29T12:00:00.000Z`), whatever offset they were written with. Passkey and link token times are `text` and come back exactly as written. Every table has an identity `seq` (or a natural key) that keeps insertion order for ties.

| Table                                                                                         | Notes                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `audit_runs`, `analyses`, `activity`                                                          | `report` / `data` / `details` in `jsonb`; indexes on time and repository                                                                                                             |
| `credentials`, `settings`                                                                     | `scope`, `rotation`, `options`, `value` in `jsonb`                                                                                                                                   |
| `users`, `passkeys`, `identities`, `link_tokens`                                              | children reference `users (id) ON DELETE CASCADE`; `email_lower` for case-insensitive lookup                                                                                         |
| `jobs`                                                                                        | partial index of due jobs; partial unique index `jobs_one_running_per_analyzer` on `(repo_forge, repo_path, analyzer) WHERE status = 'running'`; `jobs_active_repo` for claim checks |
| `knowledge`, `knowledge_history`                                                              | generated `tsvector` column `search` with a GIN index; history cascades on delete                                                                                                    |
| `ai_usage`                                                                                    | `groups` in `jsonb` with a GIN index; tokens and durations `bigint`, cost `double precision`                                                                                         |
| `config_documents`, `config_history`, `kv`                                                    | documents keyed by `(type, id)`; `kv.expires_at` is a `timestamptz`; leases and compare-and-set are single statements on `kv`                                                        |
| `external_accounts`                                                                           | unique `(provider, external_id)`; not tied to `users` by a foreign key (principals of other providers link too)                                                                      |
| `audit_events`, `audit_state`                                                                 | each event whole in `jsonb` plus filter columns; one `audit_state` row holds the chain head and how far retention swept                                                              |
| `libraries`, `library_versions`, `library_chunks`, `library_chunk_versions`, `library_issues` | migration 10; records and issues whole in `data` (`jsonb`), chunk versions in their own table (cascading on chunk delete), generated `tsvector` columns `search` with GIN indexes    |

## Behavior worth knowing

- **Job claims.** `claim` runs in one transaction: it picks the first due job that may start under the `ClaimRules` and locks it with `FOR UPDATE SKIP LOCKED`, so concurrent workers never wait on or share a row. Then it takes a transaction-level advisory lock on the job's repository and marks the job running only if it still may start. Workers starting jobs of one repository serialize on that lock and each sees what the previous one committed, so a reader never starts next to an exclusive job even when two workers pick jobs of one repository at the same moment; the loser rolls back and picks again. The unique index `jobs_one_running_per_analyzer` backs the one-job-per-analyzer rule. Migration 9 replaced the older `jobs_one_running_per_repo` index; running rows of an existing database always satisfy the new one. `heartbeat`, `fail`, `cancel` and `recoverStale` are single conditional `UPDATE`s; `appendLog` trims the log to the last `JOB_LOG_LIMIT` lines in the same statement.
- **Knowledge search.** `search` = `setweight(title, 'A') || setweight(tags, 'B') || setweight(body, 'C')` over `to_tsvector('simple', knowledge_fold(...))`, where `knowledge_fold` is `unaccent` when available. The input is split into words like the memory store does, each word becomes a quoted prefix operand (`'migr':*`) and words are OR-ed, so operators, quotes and punctuation are always plain text. Results are ordered by `ts_rank` with weights title 1.0, tags 0.6, body 0.2 (the 5 : 3 : 1 of the SQLite store), then by recency; `score` is that rank. `put` serializes writers of one entry with an advisory lock, so versions never collide.
- **Library search.** `library_chunks.search` = `setweight(heading_text, 'A') || setweight(text, 'C')`, `library_issues.search` = `setweight(title, 'A') || setweight(digest_text, 'B') || setweight(body_text, 'C')`, over `to_tsvector('simple', library_search_text(...))`, which replaces ASCII punctuation with spaces (so `fs.readFile` indexes `fs` and `readfile` instead of one host-like token) and applies `knowledge_fold`. `libraryTsQuery` builds the query from words (`'use':*`) and quoted phrases (`('cannot' <-> 'read')`), OR-ed; results are ordered by `ts_rank` with the knowledge weights. `listVersions` and chunk `versions` are sorted in JavaScript by `compareLibraryVersions`; chunk lists use the `C` collation for path order. `libraryStats` is one query with correlated `count(*)` subqueries per library.
- **AI usage aggregates.** One static `GROUP BY` query: every dimension is computed only when requested (`to_char(at AT TIME ZONE 'UTC', ...)` for `day` and `month`, `date_trunc('week', ...)` for the Monday of the ISO week), the others collapse to `''`. `group` expands `groups` with a lateral join. Scope filters resolve to the covered (repository, groups) pairs first, like SQLite.
- **Audit log.** `append` locks the `audit_state` row, so appends from every process form one chain. `sweep` deletes the oldest events up to the first one at or after the cutoff and records how far it went, so `verifyChain` still knows where the kept chain starts after everything was swept.

## Differences from SQLite

- Several processes can share the database; SQLite serializes writers on one file.
- `jsonb` does not keep object key order or duplicate keys, and cannot hold `\u0000` in strings. Values compare equal after a round trip, but key order may differ.
- Timestamps are real instants: written `+02:00` offsets come back as UTC `...Z`, and invalid timestamps are rejected instead of stored as text.
- Search uses the `simple` text search configuration, not FTS5 `unicode61`. Ranks are not the same numbers as SQLite's `-bm25`, but order results the same way (title over tags over body). Without `unaccent`, `cafe` does not find `café`.
- Lists ordered by text (config documents) use the `C` collation, matching the memory store's code-unit order regardless of the database locale.

## Backups

- Logical: `pg_dump --schema=holtkeeper --format=custom "$DATABASE_URL" > holtkeeper.dump`, restore with `pg_restore --dbname "$DATABASE_URL" holtkeeper.dump`. A dump is a consistent snapshot of a running database.
- Physical / point in time: use your platform's base backups and WAL archiving (managed Postgres, `pgBackRest`, `barman`).
- Credential secrets and webhook secrets are sealed by the `Vault`; back up the vault key separately from the database.

## Tests

`src/postgres.test.ts` runs `describeStoreContract('postgres', ...)` plus Postgres-specific tests (concurrent starts, migration rollback, same-repository claim races with exclusive jobs, the running-job index migration, timestamp normalization, accent folding) when `HOLTKEEPER_PG_URL` is set. Each store under test gets its own schema `holtkeeper_test_<run>_<n>`, dropped afterwards. Without the variable those tests are skipped; `src/rows.test.ts`, `src/queries.test.ts` and `src/libraries.test.ts` (row mapping, filter parameters, search terms, migration ordering) always run.

```sh
docker run --rm -d --name holtkeeper-pg -e POSTGRES_PASSWORD=pw -p 55432:5432 postgres:17-alpine
HOLTKEEPER_PG_URL=postgres://postgres:pw@localhost:55432/postgres bun test packages/store-postgres
docker stop holtkeeper-pg
```
