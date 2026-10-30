# @holtkeeper/forge

The provider-neutral interface to Git hosting. Plugins use `GitForge` and never a GitLab or GitHub client directly; adapters such as `@holtkeeper/forge-gitlab` implement it.

## ForgeDefinition

What the config holds under `forges`:

```ts
interface ForgeDefinition {
  kind: string // 'gitlab', 'github', ...
  url: string
  create(): GitForge
  gitCredentials?(): { username: string; password: string }
  withFetch?(wrap: (fetch: ForgeFetch) => ForgeFetch): ForgeDefinition
}
```

`withFetch` returns the same forge with its HTTP `fetch` wrapped, e.g. by shared rate limits; adapters that do not use `fetch` leave it out.

`create` is called lazily, when a task needs the forge, which is also when secrets are resolved. `gitCredentials()` returns HTTPS basic-auth credentials for `git clone`/`git fetch` of the forge's repositories (GitLab: username `oauth2`, the token as password); it resolves secrets on each call, and forges that cannot provide credentials leave it out.

## GitForge

Repositories are addressed by their full path (`games/slots-x`), merge requests by their per-repository number (GitLab `iid`, GitHub PR number). The terms follow GitLab — merge request, pipeline, job — and adapters map them to their provider.

| Area                 | Methods                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------ |
| Repositories         | `listRepositories`, `getRepository`, `readFile`, `listFiles` (optional)                                      |
| Branches and commits | `createBranch`, `deleteBranch`, `commit` (several file changes in one commit, through the API)               |
| Merge requests       | `findMergeRequest`, `createMergeRequest`, `updateMergeRequest`, `mergeMergeRequest`, `commentOnMergeRequest` |
| Pipelines            | `listPipelines`, `listJobs`, `playJob`, `retryJob`                                                           |
| Tags                 | `createTag`                                                                                                  |
| Account (optional)   | `getCurrentUser`: the token's user with the email commits should use (`ForgeUser`)                           |
| Insights (optional)  | `listMergeRequests`, `listPipelineRuns`, `listJobRuns`, `listProjectJobRuns`, `listDeployments`, `listTags`  |

### Listing files

`listFiles?(repo, { path?, ref?, recursive?, limit? }): Promise<TreeEntry[]>` lists `{ path, type: 'file' | 'dir' }` entries below `path` (root by default) at `ref` (default branch by default), direct children unless `recursive`, at most `limit` entries (default 10 000). Paths are relative to the repository root. A missing path or ref gives an empty list; submodules are left out. Used to expand workspace globs without a clone.

### Insight reads

Optional, read-only history for delivery analytics (`@holtkeeper/delivery`). Adapters may lag behind, so callers check that a method exists before calling it. Lists are newest first, times are ISO 8601, durations are seconds and absent while unknown, and `limit` caps the result (all matching items when omitted).

| Method                                                                      | Returns                                                                                                                                                                                                         |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listMergeRequests(repo, { state?, updatedAfter?, targetBranch?, limit? })` | `MergeRequestRecord`: a `MergeRequest` plus `createdAt`, `updatedAt`, `mergedAt?`, `closedAt?`, `firstCommitAt?` and `changesCount?` (the last two only when cheap for the provider); `state` defaults to `all` |
| `listPipelineRuns(repo, { ref?, after?, limit? })`                          | `PipelineRun`: a `Pipeline` plus `createdAt`, `updatedAt?`, `startedAt?`, `finishedAt?`, `durationSeconds?`, `queuedSeconds?`, `source?`; `after` filters by creation time                                      |
| `listJobRuns(repo, pipelineId)`                                             | `JobRun`: a `Job` plus `pipelineId`, timing, `retried` (a later attempt replaced it) and `allowFailure`; retried attempts are included                                                                          |
| `listProjectJobRuns(repo, { after?, limit? })`                              | `JobRun`s of every pipeline, newest first, retried attempts included, with `ref` and `sha` of their pipeline; much cheaper than `listJobRuns` per pipeline for long histories                                   |
| `listDeployments(repo, { environment?, after?, limit? })`                   | `Deployment`: `id`, `environment`, `status` (`pending`, `running`, `success`, `failed`, `canceled`, `skipped`, `blocked`), `sha`, `ref`, `createdAt`, `finishedAt?`; `after` filters by update time             |
| `listTags(repo, { limit? })`                                                | `TagRecord`: a `Tag` plus `committedAt` (date of the tagged commit) and `createdAt?` (annotated tags)                                                                                                           |

This covers the first milestones (browserslist, audit, releases). Diffs, line threads with suggestions and webhook events are added with code review.

### Webhooks

Optional: `ensureWebhook(target, { url, secret, events })` makes sure a hook with that URL exists on a group (`{ group }`) or project (`{ project }`) and carries this secret and these events (`push`, `tag_push`, `merge_request`, `note`, `pipeline`); an existing hook with the same URL is updated, never duplicated. It returns `{ id, hooks, fallback? }`: `hooks` are the hooks set up (`{ id, scope, target }`), and `fallback` explains when a group target got one hook per project instead. `removeWebhook(hooks)` removes them, ignoring hooks that are already gone.

## Secrets

```ts
type Secret = string | { env: string }
```

`env(name)` creates an environment reference; `resolveSecret(secret)` returns the value and throws if the variable is not set. Adapters accept `Secret` for tokens.
