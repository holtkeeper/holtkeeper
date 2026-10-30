# @holtkeeper/store-sqlite

SQLite implementation of the `Store` contract from `@holtkeeper/store`, built on `bun:sqlite` (no ORM, no extra dependencies). It passes `describeStoreContract` unchanged, so it behaves like `memoryStore`: lists are newest first, `limit` defaults to 50, `before` is exclusive, `put` is an upsert, email lookup ignores case, and unset optional fields are absent.

## Usage

```ts
import { sqliteStore } from '@holtkeeper/store-sqlite'

const store = sqliteStore({ path: './data/holtkeeper.db' }) // or ':memory:'
await store.activity.append({ at: new Date().toISOString(), actor: 'root', action: 'store.opened' })
await store.close()
```

`sqliteStore({ path })` opens (and creates) the file, sets `journal_mode=WAL`, `foreign_keys=ON` and `busy_timeout=5000`, and applies pending migrations before returning. The parent directory must exist.

Passkeys, identities and link tokens reference their user with a foreign key: saving one for an unknown user fails, and `removeUser` cascades to all three. External accounts have no foreign key (principals of other auth providers have no user row); `removeUser` deletes them in the same transaction. v8 also adds `users.avatar_seed`.

Audit appends and sweeps run in `BEGIN IMMEDIATE` transactions that read and move the chain head in `audit_chain`, so several connections never fork the chain and `seq` is not reused after a sweep.

## Schema

Columns that are queried or filtered are real columns; nested data is JSON text.

| Table                    | Real columns                                                                                                              | JSON columns                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `audit_runs`             | `id`, `repo_forge`, `repo_path`, `trigger`, `actor`, `started_at`, `finished_at`                                          | `report`                                                   |
| `credentials`            | `id`, `name`, `kind`, `url`, `secret`, `expires_at`, `last_rotated_at`, `last_error`, timestamps                          | `scope`, `rotation`, `options` (v5)                        |
| `settings`               | `id`, `key`, `secret`, `updated_at`, `updated_by`                                                                         | `scope`, `value`                                           |
| `users`                  | `id`, `name`, `email`, `email_lower`, `disabled`, `session_version`, `created_*`                                          | `grants`                                                   |
| `passkeys`               | `id`, `user_id`, `public_key`, `counter`, `label`, timestamps                                                             | `transports`                                               |
| `identities`             | `(provider, subject)`, `user_id`, `email`                                                                                 |                                                            |
| `link_tokens`            | `token_hash`, `user_id`, `purpose`, `expires_at`, `used_at`, `created_by`                                                 |                                                            |
| `activity`               | `id`, `at`, `actor`, `action`, `subject`                                                                                  | `details`                                                  |
| `knowledge`              | `id`, `title`, `body`, `kind`, `status`, `source`, `author`, `supersedes`, `tags`, `version`, timestamps                  | `scope`, `topics`, `applies_to`, `packages`, `evidence`    |
| `knowledge_history`      | `(entry_id, version)`, `edited_by`, `edited_at`                                                                           | `content`                                                  |
| `ai_usage`               | every field of the record                                                                                                 | `groups`                                                   |
| `audit_events` (v8)      | `seq`, `id`, `at`, `actor_id`, `via`, `action`, `target_type`, `target_id`, `target_repo`, `outcome`, `prev_hash`, `hash` | `event` (the whole event, the source of truth for hashing) |
| `audit_chain` (v8)       | one row: `head_seq`, `head_hash`, `swept_through`                                                                         |                                                            |
| `external_accounts` (v8) | `id`, `user_id`, `(provider, external_id)` unique, `username`, `verification`, `linked_*`, `verified_at`                  | `challenge`, `principal`                                   |

Indexes: audit runs by `finished_at` and by `(repo_forge, repo_path, finished_at)`, activity by `at`, settings by `key`, users by `email_lower`, and `user_id` on the child tables. Timestamps are ISO 8601 strings, which sort correctly as text. Every table also has an internal `seq` (or natural key) that keeps insertion order stable for ties.

## Knowledge search

Migration 4 adds `knowledge`, `knowledge_history` (cascades on delete) and `knowledge_fts`, an FTS5 external-content table over `knowledge` (`title`, `tags`, `body`; `tags` holds topics and package names) kept in sync by insert, update and delete triggers. The tokenizer is `unicode61` with diacritics removed, so `cafe` finds `café`.

`search` turns the text into a query that cannot fail to parse (`ftsQuery`): every word becomes a quoted prefix term and terms are OR-ed — `react "migr` becomes `"react"* OR "migr"*`, and `AND`, `NEAR(`, `-`, `col:` are plain words. Results are ordered by `bm25` with column weights title 5, tags 3, body 1; the returned `score` is `-bm25`, so higher is better. Filters run inside the same query, so `limit` applies after filtering.

## Migrations

`src/migrations.ts` holds an ordered list of `{ version, sql }` steps. On open, every step whose version is not recorded in `schema_migrations` runs, in version order, inside one `BEGIN IMMEDIATE` transaction (so a lower version merged after a higher one was applied still runs), so concurrent openers serialize and a failed step leaves the database untouched. Opening an up-to-date database changes nothing.

To change the schema, append a new step with the next version (`ALTER TABLE ... ADD COLUMN`, `CREATE TABLE`, ...). Never edit a released step.

## Backup

- Use a consistent snapshot, not a plain copy of a live file: `sqlite3 holtkeeper.db ".backup backup.db"` or `VACUUM INTO 'backup.db'`.
- If you copy files by hand, copy `holtkeeper.db`, `holtkeeper.db-wal` and `holtkeeper.db-shm` together, or stop the process first.
- Credential secrets are stored sealed by the `Vault`; back up the vault key separately from the database.
- Restore by placing the backup at the configured path while the process is stopped.

## AI usage

Migration 6 adds `ai_usage` with indexes on `(at)` and `(repo_forge, repo_path, at)`. `aggregate` is one `GROUP BY` query; `group` joins `json_each(groups)`, `week` is computed with `date(..., '-N days')`. Scope filters use path globs, which SQL cannot match the way `scopeCoversRepo` does, so they first resolve to the distinct (repository, groups) pairs passing the other filters and then restrict the query to the covered ones.

`kv.acquireLease`, `releaseLease` and `compareAndSet` run in `BEGIN IMMEDIATE` transactions, so processes sharing the file (and its WAL) see them atomically; for processes on different hosts use Postgres.
