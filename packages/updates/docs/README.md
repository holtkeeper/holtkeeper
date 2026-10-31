# @holtkeeper/updates

Finding forge changes without webhooks. `pollRepository` compares a repository with what the previous poll saw and reports the difference as `ForgeEvent`s (from `@holtkeeper/forge`), the same events a webhook delivery turns into, so the server reacts to both the same way. The rest of the package decides how often a repository may be polled when many share one forge token.

## Polling one repository

```ts
const { events, cursor, requests } = await pollRepository({
  forge, // GitForge
  repo, // { forge, path }
  cursor, // RepoCursor from the previous poll, or undefined
  now: new Date(),
  events: ['mergeRequests', 'notes', 'pipelines', 'tags', 'pushes'],
})
```

- **First poll** (`cursor` undefined) records open merge requests, recent finished pipelines and tags and reports nothing, so turning polling on never replays history.
- **Merge requests** (`listMergeRequests` with `updatedAfter`): `open`, `merge`, `close`, `reopen`, and `update` when the head moved (`newCommits`), the merge request left draft (`leftDraft`) or labels were added (`labelsAdded`). The head comes from `MergeRequestRecord.headSha`, else from `getMergeRequest`.
- **Comments** (`listDiscussions` of merge requests that changed): every non-system note newer than the last one seen, with `inThread` set for diff notes and replies.
- **Pipelines** (`listPipelines` with `updatedAfter`): pipelines that ended `success` or `failed` on the head of an open merge request, once each.
- **Tags** (`listTags`, newest 20): new tags and tags that moved.
- **Pushes** (`listBranches`, every branch): `push` events for branches whose head moved and new branches, oldest commit first. The first poll that lists branches only records them, also for cursors written before branches were polled. Push events carry the head the previous poll saw as `before`. The server asks for pushes only while something reacts to them (`jobs.onPush`, or the library index's `refreshOnPush`), since listing every branch costs a request per page.

Kinds the forge cannot list are skipped. Windows overlap by two minutes for clock skew; a change already in the cursor is not reported again. `requests` counts forge calls (about one HTTP request each) for budgeting. Polling cannot see who made a change, so `actor` is empty: changes the bot made itself are not filtered out the way webhook events by `jobs.botUsername` are.

The cursor is JSON and stays small: open merge requests and those closed in the last week (at most 200), the last 100 tags, 200 reported pipelines and up to 500 branch heads.

## Setting

`pollingSetting` is the scoped setting `polling` (section `Updates`), so it can be set for everything, a group or a repository:

```ts
{
  enabled: boolean
  interval?: string // '30s' | '5m' | '1h' | '1d', at least 30s; default 5m
  events?: ('mergeRequests' | 'notes' | 'pipelines' | 'tags' | 'pushes')[] // default all
  withWebhook?: string | 'off' // interval while webhooks reach the repository; default 1h
}
```

`pollingConfig(value)` applies the defaults and turns an unset or invalid value off. `intervalMs('5m')` parses intervals. Presets: webhook first, responsive, relaxed, off.

`defaultPolling` is the entry a fresh install starts with for every repository: `{ enabled: true, interval: '5m', withWebhook: '1h' }`, so repositories without webhooks react to changes without setup. The server seeds it next to `defaultSettings` of [@holtkeeper/settings](../../settings/docs/README.md#defaults-on-a-fresh-install).

## Sharing a token

Polls draw from the same per-credential limiter as jobs, so they can never exceed a token's limits; the budget below keeps them from crowding jobs out.

- `stretchFactors(demands, budgetOf)` sums what every repository of a key asks for (`cost × 60 000 / intervalMs` requests per minute) and returns, per key, how much slower all of them must be polled to fit the key's polling budget: `1` when it fits. Every repository of a key slows down by the same factor.
- `DEFAULT_POLL_SHARE` (0.2): the share of a key's `requestsPerMinute` polling may use unless `limits.credentials` sets `pollShare`.
- `firstDueAt(repoKey, now, intervalMs)` places a never-polled repository at a stable point within one interval, so repositories of one key do not all start together.
- `createSpendWindow()` tracks requests spent per key over the last minute, so one tick never starts more polls than the budget allows.
