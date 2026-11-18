# @holtkeeper/store-sqlite

SQLite implementation of the `Store` contract from `@holtkeeper/store`, built on `bun:sqlite` (no ORM, no extra dependencies). It passes `describeStoreContract` unchanged, so it behaves like `memoryStore`: lists are newest first, `limit` defaults to 50, `before` is exclusive, `put` is an upsert, email lookup ignores case, and unset optional fields are absent.

## Usage

```ts
import { sqliteStore } from '@holtkeeper/store-sqlite'

const store = sqliteStore({ path: './data/holtkeeper.db' }) // or ':memory:'
await store.settings.list()
await store.close()
```

`sqliteStore({ path })` opens (and creates) the file, sets `journal_mode=WAL`, `foreign_keys=ON` and `busy_timeout=5000`, and applies pending migrations before returning. The parent directory must exist.

Passkeys, identities and link tokens reference their user with a foreign key: saving one for an unknown user fails, and `removeUser` cascades to all three. External accounts have no foreign key (principals of other auth providers have no user row); `removeUser` deletes them in the same transaction. v8 also adds `users.avatar_seed`.

`audit.summary` groups days by the first ten characters of `at` (timestamps are stored as UTC ISO strings) and reads actor names from the stored event JSON.

Audit appends and sweeps run in `BEGIN IMMEDIATE` transactions that read and move the chain head in `audit_chain`, so several connections never fork the chain and `seq` is not reused after a sweep.

## Schema

Columns that are queried or filtered are real columns; nested data is JSON text.

| Table                          | Real columns                                                                                                                                         | JSON columns                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `credentials`                  | `id`, `name`, `kind`, `url`, `secret`, `expires_at`, `last_rotated_at`, `last_error`, `last_used_at` (v27), timestamps                               | `scope`, `rotation`, `options` (v5), `capabilities` (v17)  |
| `settings`                     | `id`, `key`, `secret`, `updated_at`, `updated_by`                                                                                                    | `scope`, `value`                                           |
| `users`                        | `id`, `name`, `email`, `email_lower`, `disabled`, `session_version`, `created_*`, `last_seen_at` (v27)                                               | `grants`                                                   |
| `passkeys`                     | `id`, `user_id`, `public_key`, `counter`, `label`, timestamps                                                                                        | `transports`                                               |
| `identities`                   | `(provider, subject)`, `user_id`, `email`                                                                                                            |                                                            |
| `link_tokens`                  | `token_hash`, `user_id`, `purpose`, `expires_at`, `used_at`, `created_by`                                                                            |                                                            |
| `rules` (v34)                  | `seq`, `id`, `title`, `body`, `description`, `always_apply` (0/1, `NULL` when absent), `author`, `version`, timestamps (index on `lower(title), id`) | `scope`, `files`, `agents` (`NULL` when absent)            |
| `rule_history` (v34)           | `(rule_id, version)`, `edited_by`, `edited_at`; cascades when the rule goes                                                                          | `content` (`RuleContent`)                                  |
| `ai_usage`                     | every field of the record, `transcript_ref` (v17), index on `job_id` (v17), `interactive` (0/1) and `subject` with an index on `(actor, at)` (v24)   | `teams` (v30; `groups` before)                             |
| `audit_events` (v8)            | `seq`, `id`, `at`, `actor_id`, `via`, `action`, `target_type`, `target_id`, `target_repo`, `outcome`, `prev_hash`, `hash`                            | `event` (the whole event, the source of truth for hashing) |
| `audit_chain` (v8)             | one row: `head_seq`, `head_hash`, `swept_through`                                                                                                    |                                                            |
| `external_accounts` (v8)       | `id`, `user_id`, `(provider, external_id)` unique, `username`, `verification`, `linked_*`, `verified_at`                                             | `challenge`, `principal`                                   |
| `libraries` (v11)              | `(ecosystem, name)`                                                                                                                                  | `data` (the whole record)                                  |
| `library_versions` (v11)       | `(ecosystem, name, version)`                                                                                                                         | `data` (the whole record)                                  |
| `library_chunks` (v11)         | `seq`, `id`, `ecosystem`, `name`, `source`, `path`, `position`, `heading_text`, `anchor`, `text`, `url`                                              | `headings`                                                 |
| `library_chunk_versions` (v11) | `(chunk_id, version)`, cascades when the chunk goes                                                                                                  |                                                            |
| `library_issues` (v11)         | `seq`, `id`, `ecosystem`, `name`, `state`, `updated_at`, `title`, `digest_text`, `body_text`                                                         | `data` (the whole issue)                                   |
| `learnings` (v34)              | `seq`, `id`, `key`, `text`, `status`, `origin`, `created_at`, `updated_at` (indexes on `key`, `updated_at` and `status`)                             | `data` (the whole learning)                                |
| `learning_claims` (v16)        | `key`, `at`                                                                                                                                          |                                                            |
| `review_reactions` (v16)       | `(repo, merge_request, note_id)`                                                                                                                     | `data` (the counts)                                        |
| `chat_threads` (v18)           | `id`, `updated_at`, `archived` (index on `archived, updated_at`)                                                                                     | `data` (the thread), `context_repos` (v26, `[]` for older) |
| `chat_messages` (v18)          | `seq` (the cursor), `id` unique, `thread_id`, `author_id`, `created_at`, `updated_at` (indexes on `thread_id, seq` and changed messages)             | `data` (the message), `refs` (v26, `[]` for older)         |
| `chat_thread_reads` (v18)      | `(thread_id, user_id)`, `last_read_message_id`, `last_read_seq`                                                                                      |                                                            |
| `chat_thread_mutes` (v26)      | `(user_id, thread_id)`                                                                                                                               |                                                            |
| `agent_task_groups` (v21)      | `id`, `updated_at` (index)                                                                                                                           | `data` (the whole group)                                   |
| `slack_messages` (v28)         | `(channel, ts, repo, merge_request)`, `created_at` (indexes on `repo, merge_request` and `created_at`)                                               | `data` (the whole link)                                    |
| `slack_replies` (v29)          | `(channel, ts)`, `created_at` (index)                                                                                                                | `data` (the whole status reply)                            |
| `agent_tasks` (v21)            | `id`, `group_id`, `repo`, `status`, `updated_at` (indexes on `group_id` and `repo, updated_at`)                                                      | `data` (the whole task)                                    |

Indexes: settings by `key`, users by `email_lower`, and `user_id` on the child tables. Timestamps are ISO 8601 strings, which sort correctly as text. Every table also has an internal `seq` (or natural key) that keeps insertion order stable for ties.

## Rule and learning search

Migration 34 adds `rules_fts` (`title`, `description`, `body`) and `learnings_fts` (`text`), FTS5 external-content tables over `rules` and `learnings` kept in sync by insert, update and delete triggers. The tokenizer is `unicode61` with diacritics removed, so `cafe` finds `café`.

`search` turns the text into a query that cannot fail to parse (`ftsQuery`): every word becomes a quoted prefix term and terms are OR-ed — `react "migr` becomes `"react"* OR "migr"*`, and `AND`, `NEAR(`, `-`, `col:` are plain words. Results are ordered by `bm25`, for rules with column weights title 5, description 3, body 1; the returned `score` is `-bm25`, so higher is better. Learning filters run inside the same query, so `limit` applies after filtering.

Migration 23 adds the JSON column `analyses.metrics`. Existing records keep it `NULL` (no backfill): servers compute metrics of the newest records from their data when they read them, until the next run stores them.

Migration 22 cleans up after retired features (no schema change): it deletes analysis records and jobs of the retired analyzers (`changelog`, `quality`, `release-risk`, `fleet`, `delivery`, `port`, `warmup`), settings rows under the retired keys (`llm.model`, `llm.models`, `review.instructions`, `agent.instructions`, `analyzers.<retired kind>`), the digest and Slack policy entries in `kv` (`digests`, `digest:*`, `chat:slack:policy`; the stored Slack tokens in `chat:slack:connection` stay), and removes those analyzers from schedule and trigger documents. A document left with no analyzer (or a command trigger for one) is deleted with its history; any other changed document gets a new version by `system`, its previous version archived in `config_history`. The server still ignores such leftovers (retired setting keys, unknown analyzers in schedules, triggers and commands, records of unknown kinds) on stores that never ran it.

Migration 24 adds `ai_usage.interactive` (0 for older rows) and `ai_usage.subject`, indexes `ai_usage` by `(actor, at)` and `jobs` by `analysis_id` (partial, where set) for `JobQuery.analysisId`.

Migration 30 renames `ai_usage.groups` to `ai_usage.teams` (the owner teams of `AiUsageRecord.teams`). It converts no values: stored group keys become team keys through the separate one-off conversion, not here.

Migration 32 deletes the settings rows of the retired `slack.reviews` key (no schema change); other settings stay.

Migration 34 drops the notes (`knowledge`, `knowledge_history`, `knowledge_fts` and its triggers), the Guide (`guides`, `guide_history`, `guide_generated`), `families`, `embeddings` and the old `learnings` candidates, and creates `rules`, `rule_history`, `learnings` and their search tables. Nothing is carried over; `learning_claims` and `review_reactions` stay as they are.

## Backup

- Use a consistent snapshot, not a plain copy of a live file: `sqlite3 holtkeeper.db ".backup backup.db"` or `VACUUM INTO 'backup.db'`.
- If you copy files by hand, copy `holtkeeper.db`, `holtkeeper.db-wal` and `holtkeeper.db-shm` together, or stop the process first.
- Credential secrets are stored sealed by the `Vault`; back up the vault key separately from the database.
- Restore by placing the backup at the configured path while the process is stopped.

## AI usage

Migration 6 adds `ai_usage` with indexes on `(at)` and `(repo_forge, repo_path, at)`. `aggregate` is one `GROUP BY` query; `team` joins `json_each(teams)`, `week` is computed with `date(..., '-N days')`. Scope filters use path globs, which SQL cannot match the way `scopeCoversRepo` does, so they first resolve to the distinct (repository, teams) pairs passing the other filters and then restrict the query to the covered ones.

`kv.acquireLease`, `releaseLease` and `compareAndSet` run in `BEGIN IMMEDIATE` transactions, so processes sharing the file (and its WAL) see them atomically; for processes on different hosts use Postgres.
