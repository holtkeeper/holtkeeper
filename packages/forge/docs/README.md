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
  fetch?: ForgeFetch
}
```

`withFetch` returns the same forge with its HTTP `fetch` wrapped, e.g. by shared rate limits; adapters that do not use `fetch` leave it out. `fetch` is the wrapped `fetch` itself, for tools that call the forge API on their own and must share those limits (Renovate through [@holtkeeper/renovate](../../renovate/docs/README.md)).

`create` is called lazily, when a task needs the forge, which is also when secrets are resolved. `gitCredentials()` returns HTTPS basic-auth credentials for `git clone`/`git fetch` of the forge's repositories (GitLab: username `oauth2`, the token as password); it resolves secrets on each call, and forges that cannot provide credentials leave it out.

## GitForge

Repositories are addressed by their full path (`games/app-x`), merge requests by their per-repository number (GitLab `iid`, GitHub PR number). The terms follow GitLab — merge request, pipeline, job — and adapters map them to their provider.

| Area                 | Methods                                                                                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repositories         | `listRepositories`, `getRepository`, `readFile`, `listFiles` (optional)                                                                                                             |
| Branches and commits | `createBranch`, `deleteBranch`, `commit` (several file changes in one commit, through the API)                                                                                      |
| Merge requests       | `findMergeRequest`, `createMergeRequest`, `updateMergeRequest`, `mergeMergeRequest`, `commentOnMergeRequest`                                                                        |
| Pipelines            | `listPipelines` (`ref`, `sha`, `updatedAfter`), `listJobs`, `playJob`, `retryJob`                                                                                                   |
| Tags                 | `createTag`                                                                                                                                                                         |
| History (optional)   | `listCommits(repo, { ref, since?, limit? })`: commits reachable from `ref` and not from `since` (`git log since..ref`), newest first, as `CommitRecord`                             |
| Releases (optional)  | `getRelease(repo, tag)`, `createRelease(repo, { tag, name, description })`, `updateRelease(repo, { tag, name?, description? })` → `ForgeRelease { tag, name, description, webUrl }` |
| Account (optional)   | `getCurrentUser`: the token's user with the email commits should use (`ForgeUser`)                                                                                                  |
| Insights (optional)  | `listMergeRequests`, `listPipelineRuns`, `listJobRuns`, `listProjectJobRuns`, `listDeployments`, `listTags`, `listBranches`, `listCiVariables`, `listImageTags`, `npmRegistry`      |

### Listing files

`listFiles?(repo, { path?, ref?, recursive?, limit? }): Promise<TreeEntry[]>` lists `{ path, type: 'file' | 'dir' }` entries below `path` (root by default) at `ref` (default branch by default), direct children unless `recursive`, at most `limit` entries (default 10 000). Paths are relative to the repository root. A missing path or ref gives an empty list; submodules are left out. Used to expand workspace globs without a clone.

### Insight reads

Optional, read-only history for delivery analytics (`@holtkeeper/delivery`). Adapters may lag behind, so callers check that a method exists before calling it. Lists are newest first, times are ISO 8601, durations are seconds and absent while unknown, and `limit` caps the result (all matching items when omitted).

| Method                                                                      | Returns                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listMergeRequests(repo, { state?, updatedAfter?, targetBranch?, limit? })` | `MergeRequestRecord`: a `MergeRequest` plus `createdAt`, `updatedAt`, `mergedAt?`, `closedAt?`, `firstCommitAt?`, `changesCount?` and `headSha?` (the last three only when cheap for the provider); `state` defaults to `all`         |
| `listPipelineRuns(repo, { ref?, after?, limit? })`                          | `PipelineRun`: a `Pipeline` plus `createdAt`, `updatedAt?`, `startedAt?`, `finishedAt?`, `durationSeconds?`, `queuedSeconds?`, `source?`; `after` filters by creation time                                                            |
| `listJobRuns(repo, pipelineId)`                                             | `JobRun`: a `Job` plus `pipelineId`, timing, `retried` (a later attempt replaced it) and `allowFailure`; retried attempts are included                                                                                                |
| `listProjectJobRuns(repo, { after?, limit? })`                              | `JobRun`s of every pipeline, newest first, retried attempts included, with `ref`, `sha` and `tag` (the pipeline ran for a tag) of their pipeline; much cheaper than `listJobRuns` per pipeline for long histories                     |
| `getRepositoryAvatar(repo)`                                                 | `ForgeImage { data, contentType }`: the project's avatar, else the nearest parent group's; `undefined` when none has one. `imageType(bytes)` tells PNG, JPEG, GIF, WebP and SVG apart by signature                                    |
| `listDeployments(repo, { environment?, after?, limit? })`                   | `Deployment`: `id`, `environment`, `status` (`pending`, `running`, `success`, `failed`, `canceled`, `skipped`, `blocked`), `sha`, `ref`, `createdAt`, `finishedAt?`; `after` filters by update time                                   |
| `listTags(repo, { limit? })`                                                | `TagRecord`: a `Tag` plus `committedAt` (date of the tagged commit) and `createdAt?` (annotated tags)                                                                                                                                 |
| `listBranches(repo)`                                                        | `BranchRecord`: every branch with `name`, head `sha`, `committedAt`, `authorName?`, `authorEmail?`, `merged` (head reachable from the default branch; squash merges do not count), `protected`, `default`, `webUrl?`                  |
| `listCiVariables({ kind, path })`                                           | `CiVariable { key, value, environmentScope }` defined directly on a repository or group (no inherited ones); masked, hidden and file variables are left out. `undefined` when the token may not read them or the scope does not exist |
| `listImageTags(image)`                                                      | Tags of an image (`registry/path`, no tag) in the forge's own container registry; `undefined` when the forge does not serve it or the token may not read it                                                                           |
| `npmRegistry(repo)`                                                         | Base URL of the npm registry the forge runs for the repository (packages it publishes are read there with the forge token); `undefined` when there is none                                                                            |

This covers the first milestones (browserslist, audit, releases). Diffs, line threads with suggestions and webhook events are added with code review.

### Webhooks

Optional: `ensureWebhook(target, { url, secret, events })` makes sure a hook with that URL exists on a group (`{ group }`) or project (`{ project }`) and carries this secret and these events (`WebhookEvent`, every one listed in `webhookEvents`: pushes, tags, merge requests, comments, issues, pipelines, jobs, deployments, releases, wiki pages, milestones, members, emoji, feature flags, access tokens); an existing hook with the same URL is updated, never duplicated. It returns `{ id, hooks, fallback? }`: `hooks` are the hooks set up (`{ id, scope, target }`), and `fallback` explains when a group target got one hook per project instead. `removeWebhook(hooks)` removes them, ignoring hooks that are already gone.

### Events

`ForgeEvent` is something that happened on a forge, whichever way Holtkeeper learned it (a webhook delivery or polling with `@holtkeeper/updates`):

| `kind`         | Fields                                                                                                                                                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tag`          | `repo`, `tag`, `sha`                                                                                                                                                                                                                   |
| `push`         | `repo`, `branch`, `sha` (the new head), `actor` (empty when unknown), `before?` (the head before; absent for a new branch), `files?` (every path the pushed commits touched, only when the source lists all of them), `defaultBranch?` |
| `mergeRequest` | `repo`, `action` (`open`, `reopen`, `update`, `merge`, `close`, `approved`), `actor` (empty when unknown), `newCommits`, `leftDraft`, `labelsAdded`, `mr` (with `headSha` when known)                                                  |
| `note`         | `repo`, `mergeRequest`, `mergeRequestState`, `headSha?`, `author`, `body`, `discussionId?`, `inThread` (a diff or discussion note rather than a standalone comment)                                                                    |
| `pipeline`     | `repo`, `mergeRequest`, `pipelineId`, `status`, `sha`, `actor`; only finished merge request pipelines                                                                                                                                  |

## Read-only repositories

`readOnlyForge(forge, isReadOnly)` returns `forge` with every change to a repository for which `isReadOnly(path)` (sync or async) is true rejected with `ReadOnlyRepositoryError` (`repo`, `operation`) before anything reaches the forge: `createBranch`, `deleteBranch`, `commit`, `createTag`, `createRelease`, `updateRelease`, the merge request writes (`createMergeRequest`, `updateMergeRequest`, `mergeMergeRequest`, `commentOnMergeRequest`), `submitReview`, `replyToDiscussion`, `resolveDiscussion`, `playJob`, `retryJob`, deploy keys (`registerSshKey` with a deploy scope, `enableDeployKey`) and project webhooks (`ensureWebhook` with `{ project }`). Reads, user keys, group webhooks and removing keys and hooks pass through; optional methods stay absent when the forge lacks them. `readOnlyDefinition(definition, isReadOnly)` does the same for every client a `ForgeDefinition` creates, including those of its `withFetch` copies.

## Secrets

```ts
type Secret = string | { env: string }
```

`env(name)` creates an environment reference; `resolveSecret(secret)` returns the value and throws if the variable is not set. Adapters accept `Secret` for tokens.
