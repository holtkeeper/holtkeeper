# @holtkeeper/mr-policies

Merge request policies: rules that run on merge request events before (or instead of) analysis. A policy says _when_ it applies (a condition over the event, the merge request, its diff and its pipeline) and _what_ happens (approve, merge, label, comment, close, toggle draft, assign reviewers, enqueue analyzers, call a webhook), and may tell the caller to skip analyzers for that event.

The engine only talks to `GitForge`. It never touches the job queue: skipping and enqueueing analyzers are returned as intents for the caller (the server's webhook route).

## Evaluating

```ts
const result = await evaluatePolicies({
  policies, // Policy[], e.g. from combinePolicies
  event, // MergeRequestEvent
  forge, // GitForge
  now, // optional Date
  dryRun, // optional: report what would happen, change nothing
  memory, // optional PolicyMemory; process-wide in-memory default
  botUser, // optional: Holtkeeper's forge username (no self-approval)
  bots, // optional: usernames/globs of bot users for `author.bot`
  registry, // optional: action providers, the built-ins by default
  fetch, // optional: used by the webhook action
})
// → { matched: { policyId, reasons[] }[], unmatched: { policyId, reason }[],
//     outcomes: ActionOutcome[], skipAnalyzers: '*' | string[], enqueue: { analyzer, options? }[] }
```

- **Order** — enabled policies whose `scope` (and `within`, the settings entry scope) cover the repository, most specific scope first (exact path > path glob > group > everything), list order among equals. A matching policy with `stop: true` ends evaluation.
- **Actions** run in list order. Every action yields an `ActionOutcome` `{ policyId, action, status, detail, data? }` — `done`, `dry-run`, `skipped`, `deferred`, `unsupported`, `failed` or `intent` — with a human-readable `detail` for the activity log. Errors never escape: a throwing condition makes the policy unmatched (`error: ...`), a throwing action becomes `failed`.
- **Idempotency** — `approve`, `merge` and `comment` (by default) happen once per head commit: the key `mr-policy:<forge>:<repo>!<id>@<sha>:<policy>:<action JSON>` is stored in `PolicyMemory` after a `done` outcome, and a later run with the same key is `skipped`. `deferred`, `failed` and dry-run outcomes are not remembered, so a later event (e.g. the pipeline turning green) retries them. The server should back `PolicyMemory` (`seen(key)`, `remember(key)`) with the store; `createMemory(limit)` is an in-memory LRU.
- **Intents** — `skipAnalyzers` is the union over matched policies (`*` wins). `enqueue` collects `enqueue` actions, deduplicated; it is not filtered by `skipAnalyzers`.
- **Lazy facts** — the head sha (event, else `getMergeRequest`, else diff refs), the diff (`getMergeRequestDiff`) and the latest pipeline for the head sha (`listPipelines`, highest id) are loaded once per evaluation and only when a condition or action needs them.

### Event

```ts
interface MergeRequestEvent {
  repo: RepoRef
  groups: string[]
  mr: MergeRequest & { headSha?: string }
  action: 'open' | 'update' | 'reopen' | 'label' | 'merge' | 'approve' | 'command'
  labelsAdded?: string[]
  actor: string
  isBot: boolean // the actor
  authorIsBot?: boolean // the MR author; else `bots` globs decide
  command?: string // for `command` events, without the slash
}
```

The engine works on a copy of the event; actions that change labels, state or draft update the copy so later actions see the new values.

## Conditions

All fields optional and AND-ed; checked cheapest first and stopping at the first failure, so the diff and pipelines are only loaded when still needed. Single values are accepted where lists are.

| Field                          | Holds when                                                                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `event`                        | the event action is one of these                                                                                                  |
| `sourceBranch`, `targetBranch` | the branch matches one of these globs                                                                                             |
| `author`                       | `users`: name matches a name/glob; `bot`: author is (not) a bot. A string or list is shorthand for `users`                        |
| `labels`                       | `all` present, `any` present, `none` present (exact names)                                                                        |
| `labelAdded`                   | one of these labels was added by this event                                                                                       |
| `title`                        | title matches the regex, `pattern` or `/pattern/flags`                                                                            |
| `draft`                        | draft state equals                                                                                                                |
| `command`                      | a `command` event with one of these commands                                                                                      |
| `changedPaths`                 | `all` / `any` / `none` changed paths match the globs (new path; old path for deletions). Loads the diff                           |
| `size`                         | `maxLines`, `maxFiles`, `minLines`, `minFiles` (added + removed lines). Collapsed files exceed every line limit. Loads the diff   |
| `pipeline`                     | latest pipeline for the head is `success`, `failed` (incl. canceled), `running` (incl. pending, manual) or `none` (incl. skipped) |
| `all`, `any`, `not`            | combinators over nested conditions                                                                                                |

Globs use `Bun.Glob`: `*` does not cross `/`, so write `**/*.md` for Markdown anywhere. Without `getMergeRequestDiff` path and size conditions do not hold.

## Actions

Each action is an `ActionProvider` `{ type, schema, run(action, context) → ActionResult, onceKey? }` in an `ActionRegistry`; `defineAction` wraps a provider typed by its zod schema (options are parsed before `run`, invalid ones fail the action). A new action is one file plus `createRegistry([...builtinActions, myAction])`. Providers must honour `context.dryRun`; `context.perform(detail, effect)` handles dry runs and errors.

| Type              | Options                                                                    | Notes                                                                                                                                          |
| ----------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `approve`         | `summary?`, `requirePipeline?: 'success'`, `allowSelfApprove?`             | `submitReview` with `event: 'approve'`. Deferred while the pipeline runs, skipped when not green. Refused for the bot's own MRs. Once per head |
| `merge`           | `squash?`, `removeSourceBranch?`, `whenPipelineSucceeds?` (default `true`) | Skips drafts and non-open MRs. Once per head                                                                                                   |
| `label`           | `add?`, `remove?`                                                          | `updateMergeRequest({ labels })`; skipped when nothing changes                                                                                 |
| `comment`         | `body`, `once?: 'headSha' \| 'mergeRequest' \| 'never'` (default headSha)  | Template placeholders `{author}`, `{sourceBranch}`, `{targetBranch}`, `{title}`, `{id}`, `{repo}`, `{actor}`                                   |
| `close`           | —                                                                          | `updateMergeRequest({ state: 'closed' })`                                                                                                      |
| `draft`           | `draft?` (default `true`)                                                  | Marks as draft or ready                                                                                                                        |
| `assignReviewers` | `reviewers`                                                                | Needs a forge implementing `ReviewerAssignment.assignReviewers`; otherwise `unsupported`. The author is left out                               |
| `enqueue`         | `analyzer`, `options?`                                                     | Returns an `intent`; the caller enqueues                                                                                                       |
| `webhook`         | `url: Secret`, `headers?: Record<string, Secret>`, `payload?`              | POSTs `{ policy, at, event, payload }` as JSON; non-2xx fails. URL and headers never appear in outcomes                                        |

**Safety** — `approve` and `merge` refuse (`skipped`) when the policy's scope does not cover the repository; `approve` refuses merge requests authored by `botUser` unless `allowSelfApprove`.

## Settings

`mergeRequestPoliciesSetting` is a structural `SettingDefinition` (key `mergeRequests.policies`, section `Merge requests`, schema `policiesSchema`, `help` for the panel, and a `form` that lists the built-in actions as variants keyed by `type` and is marked `x-editor: merge-request-policies`, so the panel edits policies as If/Then blocks) for the server to register so policies can be edited per scope. `combinePolicies(entries, repo, registry?)` takes setting entries (`{ key?, scope, value, updatedAt? }`, e.g. `SettingEntry`) and returns `{ policies, invalid }`:

- entries whose scope covers the repository, most specific first, newest first among equals;
- a policy without `scope` takes the entry's; one with its own `scope` applies only inside the entry's (`within`);
- an id from a more specific entry overrides the same id from less specific ones, so a repository can disable (`enabled: false`) or replace a group policy;
- invalid entries are reported in `invalid` with a readable error and otherwise ignored.

`policiesSchema` validates a list (unique ids, defaults `enabled: true`, `when: {}`, `actions: []`); `createPoliciesSchema(registry)` validates actions against a custom registry.

## Examples

Stored as the value of `mergeRequests.policies` for a scope (tested in `src/examples.test.ts`):

```json
[
  {
    "id": "release-auto-approve",
    "name": "Approve releases from the release bot",
    "when": {
      "event": ["open", "update", "reopen"],
      "sourceBranch": "release/*",
      "targetBranch": "main",
      "author": { "users": ["release-bot"], "bot": true }
    },
    "actions": [
      {
        "type": "approve",
        "requirePipeline": "success",
        "summary": "Release {sourceBranch} approved: pipeline is green."
      }
    ],
    "skipAnalyzers": "*",
    "stop": true
  },
  {
    "id": "renovate-patch-automerge",
    "name": "Auto-merge Renovate patch updates",
    "when": { "author": "renovate*", "labels": { "all": ["patch"] }, "draft": false },
    "actions": [
      { "type": "approve", "requirePipeline": "success" },
      { "type": "merge", "squash": true, "removeSourceBranch": true, "whenPipelineSucceeds": true }
    ],
    "skipAnalyzers": ["review"]
  },
  {
    "id": "docs-only",
    "name": "Label docs-only changes and skip code review",
    "when": { "event": ["open", "update"], "changedPaths": { "all": ["**/*.md", "docs/**"] } },
    "actions": [{ "type": "label", "add": ["docs-only"] }],
    "skipAnalyzers": ["review"]
  },
  {
    "id": "large-needs-review",
    "name": "Large merge requests need a human reviewer",
    "when": {
      "event": ["open", "update"],
      "size": { "minLines": 1000 },
      "labels": { "none": ["needs-review"] }
    },
    "actions": [
      { "type": "label", "add": ["needs-review"] },
      {
        "type": "comment",
        "once": "mergeRequest",
        "body": "@{author} this merge request changes 1000+ lines, so it needs a human review before merging."
      }
    ]
  }
]
```

The Renovate example expects Renovate to label patch updates (`packageRules: [{ matchUpdateTypes: ["patch"], addLabels: ["patch"] }]`). The release approval is deferred while the pipeline runs; the server re-evaluates on the next event (e.g. pipeline success), and the once-per-head key prevents a second approval.

## Limitations

- No `assignReviewers` on `GitForge` yet: the action is `unsupported` until an adapter implements `ReviewerAssignment`.
- `size` counts lines from the diff body; files the forge collapsed count as exceeding line limits.
- The default memory is per process; idempotency across restarts needs a store-backed `PolicyMemory`.
