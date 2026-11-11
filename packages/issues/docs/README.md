# @holtkeeper/issues

The contract for issue trackers: what Holtkeeper reads about a ticket key such as `ABC-123` when a tracker is connected. Release pages and the release MCP tools use it to show a task's title, status and type; without a tracker they show plain keys. Trackers are read-only: nothing here writes to them.

## Public API

- `Issue { key, title, status?, category?, type?, url? }` — one issue. `category` (`IssueCategory`: `todo`, `doing`, `done`) folds the tracker's workflow states; `status` is the tracker's own name for the state.
- `IssueTracker { provider, issues(keys) }` — a read-only tracker. `issues` returns the issues it knows among `keys` in any order and leaves unknown keys out instead of failing.
- `IssueCache { get, set(key, value, ttlSeconds?) }` — where lookups are kept; `Store.kv` fits.
- `cachedTracker(tracker, cache, { namespace, openTtlSeconds = 3600, doneTtlSeconds = 86400, missingTtlSeconds = 3600 })` — the tracker behind a cache under `issues:<provider>:<namespace>:<key>`. Keys found in the cache, including keys remembered as unknown, are not asked again until they expire; the rest go to the tracker in one call. A cache that fails is skipped.
- `issuesByKey(tracker | undefined, keys, onError?)` → `Record<string, Issue>` — never throws: without a tracker, without keys or when the tracker fails (reported to `onError`) the result is empty, so callers fall back to plain keys.

`@holtkeeper/issues/testing` has `fakeIssueTracker(issues, { fail? })`, an in-memory tracker that records the keys of each call.

## Implementations

- [@holtkeeper/issues-jira](../../issues-jira/docs/README.md) — Jira Cloud and Data Center.
