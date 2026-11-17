# @holtkeeper/issues

The contract for issue trackers: what Holtkeeper reads about a ticket key such as `ABC-123` when a tracker is connected. Release pages and the release tools of chat use it to show a task's title, status and type; without a tracker they show plain keys. Reviews use `issue` to give the reviewer the ticket a merge request names. Trackers are read-only: nothing here writes to them.

## Public API

- `Issue { key, title, status?, category?, type?, url? }` — one issue. `category` (`IssueCategory`: `todo`, `doing`, `done`) folds the tracker's workflow states; `status` is the tracker's own name for the state.
- `IssueTracker { provider, issues(keys), issue?(key) }` — a read-only tracker. `issues` returns the issues it knows among `keys` in any order and leaves unknown keys out instead of failing. `issue`, when the tracker supports it, reads one issue with its description (`IssueDetails`) and is `undefined` when the issue is unknown or not readable with the tracker's credentials.
- `IssueDetails` — an `Issue` with an optional plain-text `description`.
- `issueDetails(tracker | undefined, keys)` → the `IssueDetails` of the keys the tracker can read, in key order; empty without a tracker or `issue`. A tracker failure is thrown.
- `issueKeysIn(...texts)` → keys like `ABC-123` found in the texts, in order and once each; keys are matched as written, so upper-case a branch name first.
- `IssueCache { get, set(key, value, ttlSeconds?) }` — where lookups are kept; `Store.kv` fits.
- `cachedTracker(tracker, cache, { namespace, openTtlSeconds = 3600, doneTtlSeconds = 86400, missingTtlSeconds = 3600 })` — the tracker behind a cache under `issues:<provider>:<namespace>:<key>`. Keys found in the cache, including keys remembered as unknown, are not asked again until they expire; the rest go to the tracker in one call. A cache that fails is skipped. `issue` is passed through uncached.
- `issuesByKey(tracker | undefined, keys, onError?)` → `Record<string, Issue>` — never throws: without a tracker, without keys or when the tracker fails (reported to `onError`) the result is empty, so callers fall back to plain keys.

`@holtkeeper/issues/testing` has `fakeIssueTracker(issues, { fail?, details? })`, an in-memory tracker that records the keys of each call; with `details` it also answers `issue`.

## Implementations

- [@holtkeeper/issues-jira](../../issues-jira/docs/README.md) — Jira Cloud and Data Center.
