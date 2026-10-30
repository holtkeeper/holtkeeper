# @holtkeeper/forge-gitlab

GitLab adapter: a `GitForge` over the GitLab REST API v4 and token rotation for `@holtkeeper/credentials`.

## Forge

```ts
import { env } from '@holtkeeper/forge'
import { gitlab } from '@holtkeeper/forge-gitlab'

export default {
  forges: {
    gitlab: gitlab({ url: 'https://gitlab.example.com', token: env('GITLAB_TOKEN') }),
  },
}
```

Options: `url` (base URL, with or without a trailing slash, including the path prefix of a self-managed instance such as `https://example.com/gitlab`), `token` (`Secret`, resolved when `create()` is called), `fetch?`, `perPage?` (1 to 100, default 100) and `retries?` (how often a `429` is retried after waiting for `Retry-After`, capped at 60 s; default 1).

The token needs the `api` scope (code review writes — draft notes, publishing, approving, replying, resolving — need it too); `read_api` is enough when only `listRepositories`, `getRepository`, `readFile`, `readFileBytes`, `listFiles`, `getMergeRequest`, `getMergeRequestDiff`, `compareCommits`, `listDiscussions`, `findMergeRequest`, `listPipelines`, `listJobs` and the insight reads (`listMergeRequests`, `listPipelineRuns`, `listJobRuns`, `listProjectJobRuns`, `listDeployments`, `listTags`) are used. For the insight reads on private projects, give the user behind the token at least Reporter access; Guests may not see jobs and deployments. `git clone` over HTTPS with `gitCredentials()` needs `read_repository` (or `api`). Personal, project, group and service-account tokens work alike; the user behind the token needs Developer access to push, open merge requests and run jobs, and Maintainer access on protected branches and tags.

Repositories are projects addressed by URL-encoded full path (`games/app-x` → `projects/games%2Fapp-x`); merge request ids are GitLab `iid`s.

| Method                  | Request                                                                                                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `listRepositories`      | `GET /groups/:ns/projects?include_subgroups=true&with_shared=false`, paginated; on 404 `GET /users/:ns/projects`                                                                                                                                 |
| `getRepository`         | `GET /projects/:id`                                                                                                                                                                                                                              |
| `readFile`              | `GET /projects/:id/repository/files/:path/raw?ref=` (no `ref`: project HEAD)                                                                                                                                                                     |
| `readFileBytes`         | Same endpoint as `readFile`, body returned as bytes                                                                                                                                                                                              |
| `listFiles`             | `GET /projects/:id/repository/tree?path=&ref=&recursive=&pagination=keyset`, following `Link: rel="next"` up to `limit` (default 10 000)                                                                                                         |
| `createBranch`          | `POST /projects/:id/repository/branches`                                                                                                                                                                                                         |
| `deleteBranch`          | `DELETE /projects/:id/repository/branches/:branch`                                                                                                                                                                                               |
| `commit`                | `GET /projects/:id/repository/branches/:branch` (only with `startBranch`), `POST /projects/:id/repository/commits`                                                                                                                               |
| `findMergeRequest`      | `GET /projects/:id/merge_requests?source_branch=&target_branch=&state=` (newest first)                                                                                                                                                           |
| `createMergeRequest`    | `GET /users?username=` per reviewer, `POST /projects/:id/merge_requests`                                                                                                                                                                         |
| `updateMergeRequest`    | `GET /projects/:id/merge_requests/:iid` (when the draft flag or title needs the current value), `PUT /projects/:id/merge_requests/:iid`                                                                                                          |
| `mergeMergeRequest`     | `PUT /projects/:id/merge_requests/:iid/merge`                                                                                                                                                                                                    |
| `commentOnMergeRequest` | `POST /projects/:id/merge_requests/:iid/notes`                                                                                                                                                                                                   |
| `listPipelines`         | `GET /projects/:id/pipelines?ref=&sha=` (newest page only, `perPage` entries)                                                                                                                                                                    |
| `listJobs`              | `GET /projects/:id/pipelines/:pipeline_id/jobs`, all pages                                                                                                                                                                                       |
| `playJob`, `retryJob`   | `POST /projects/:id/jobs/:job_id/play`, `POST /projects/:id/jobs/:job_id/retry`                                                                                                                                                                  |
| `createTag`             | `POST /projects/:id/repository/tags`                                                                                                                                                                                                             |
| `listMergeRequests`     | `GET /projects/:id/merge_requests?state=&updated_after=&target_branch=&order_by=updated_at&sort=desc`, paginated up to `limit`                                                                                                                   |
| `listPipelineRuns`      | `GET /projects/:id/pipelines?ref=&created_after=&order_by=id&sort=desc` up to `limit`, then `GET /projects/:id/pipelines/:pipeline_id` for each (8 at a time)                                                                                    |
| `listJobRuns`           | `GET /projects/:id/pipelines/:pipeline_id/jobs?include_retried=true`, all pages                                                                                                                                                                  |
| `listProjectJobRuns`    | `GET /projects/:id/jobs` newest first, page by page until the first job created before `after` or `limit`                                                                                                                                        |
| `getRepositoryAvatar`   | `GET /projects/:id/avatar`, then `GET /groups/:id/avatar` up the namespace; 404s move on, the bytes' signature gives the type                                                                                                                    |
| `listDeployments`       | `GET /projects/:id/deployments?environment=&sort=desc` with `updated_after=&order_by=updated_at` when `after` is set, `order_by=id` otherwise; up to `limit`                                                                                     |
| `listTags`              | `GET /projects/:id/repository/tags?order_by=updated&sort=desc`, up to `limit`                                                                                                                                                                    |
| `getMergeRequest`       | `GET /projects/:id/merge_requests/:iid`                                                                                                                                                                                                          |
| `getMergeRequestDiff`   | `GET /projects/:id/merge_requests/:iid/versions` (all pages), then `GET .../versions/:version_id` of the latest; without versions `diff_refs` and paginated `GET .../diffs`                                                                      |
| `compareCommits`        | `GET /projects/:id/repository/compare?from=&to=&straight=true`                                                                                                                                                                                   |
| `listDiscussions`       | `GET /projects/:id/merge_requests/:iid/discussions`, all pages                                                                                                                                                                                   |
| `submitReview`          | `POST .../approve` (only `approve`), `GET .../versions` + `GET .../versions/:version_id`, `POST .../draft_notes` per comment, `POST .../draft_notes/bulk_publish`; on failure `PUT .../draft_notes/:id/publish` and `DELETE .../draft_notes/:id` |
| `replyToDiscussion`     | `POST /projects/:id/merge_requests/:iid/discussions/:discussion_id/notes`                                                                                                                                                                        |
| `resolveDiscussion`     | `PUT /projects/:id/merge_requests/:iid/discussions/:discussion_id?resolved=true\|false`                                                                                                                                                          |
| `getCurrentUser`        | `GET /user`; `email` is `commit_email`, else `email`                                                                                                                                                                                             |
| `registerSshKey`        | `POST /user/keys` with `usage_type` (`scope.kind: user`, the token's own user); `POST /projects/:id/deploy_keys` with `can_push` (deploy keys accept only usage `auth`)                                                                          |
| `listSshKeys`           | `GET /user/keys` or `GET /projects/:id/deploy_keys`, all pages; user keys without `usage_type` (pre-15.7) report `auth_and_signing`                                                                                                              |
| `removeSshKey`          | `DELETE /user/keys/:key_id` or `DELETE /projects/:id/deploy_keys/:key_id` (the key stays on other projects)                                                                                                                                      |
| `enableDeployKey`       | `POST /projects/:id/deploy_keys/:key_id/enable`, then `PUT /projects/:id/deploy_keys/:key_id` with `can_push: true` when asked (enabling never grants write access)                                                                              |

Behavior worth knowing:

- `listRepositories` yields lazily, includes archived projects (`archived` is set) and leaves out projects only shared with the group. Pages follow the `Link: rel="next"` header, or `X-Next-Page` when it is missing; a next link outside the configured API root is refused, because the token would be sent there.
- `listFiles` maps `tree` → `dir` and `blob` → `file` and skips submodules (`commit`). A 404 for the path or ref gives `[]`; a missing project still rejects.
- `readFile` returns `undefined` for 404 (missing file or ref) but rejects when the project itself is not found.
- `commit` sends all changes as one Commits API call with `create`/`update`/`delete` actions. `start_branch` is sent only when `startBranch` is given and `branch` does not exist yet.
- Merge request states map `opened`/`locked` → `open`, `merged` → `merged`, `closed` → `closed`. Draft is the `Draft: ` title prefix: `draft` on create and update adds or strips it, and an update that changes only the title keeps the current draft state. Labels are sent as a comma-separated list, reviewers are looked up by username (an unknown username rejects before the merge request is created). `state: 'closed' | 'open'` sends `state_event: close | reopen`.
- `mergeMergeRequest` sends `squash`, `should_remove_source_branch` and, for `whenPipelineSucceeds`, both `merge_when_pipeline_succeeds` and its replacement `auto_merge` (GitLab 17.11+), so old and new instances behave the same.
- Pipeline and job statuses: `created`, `waiting_for_resource`, `preparing`, `pending`, `scheduled` → `pending`; `canceling`, `canceled` → `canceled`; `running`, `success`, `failed`, `skipped`, `manual` as is; unknown statuses → `pending`.
- `gitCredentials()` returns `{ username: 'oauth2', password: <token> }`, the form GitLab accepts for HTTPS git with personal, project, group and OAuth tokens. The token is resolved on each call.
- Insight reads:
  - `listMergeRequests` maps `created_at`, `updated_at`, `merged_at` and (closed merge requests only) `closed_at`. `firstCommitAt` and `changesCount` are left out: the list endpoint has neither, and fetching them costs one request per merge request.
  - `listPipelineRuns` needs one extra request per pipeline because only the single-pipeline endpoint returns `started_at`, `finished_at`, `duration` and `queued_duration`; keep `limit` small on busy projects. `after` maps to `created_after`.
  - `listJobRuns` sends `include_retried=true`. GitLab's job objects carry no documented retried flag, so an attempt is `retried` when the same pipeline has a newer job (higher id) with the same name; a `retried` field in the response wins when present. `allowFailure` is `allow_failure`.
  - `listProjectJobRuns` has no time filter on GitLab's side, so it stops reading pages at the first job created before `after`. `retried` is derived per pipeline as in `listJobRuns`; `ref` and `sha` come from the job's `pipeline` object, `tag` from the job's `tag` flag.
  - `listDeployments` statuses: `created` → `pending`, `running`, `success`, `failed`, `canceled`, `skipped`, `blocked` as is. `finishedAt` is the deployment job's `deployable.finished_at`. GitLab rejects `updated_after` without `order_by=updated_at` (400), so results with `after` are newest update first.
  - `listTags` returns `committedAt` from `commit.committed_date` and `createdAt` from the tag's own `created_at` (annotated tags only).
- `createTag` returns the commit SHA the tag points to, also for annotated tags.
- `commit` sends `encoding: base64` for changes with `encoding: 'base64'` (binary files); text changes carry no `encoding`. `readFileBytes` returns the raw bytes with the same 404 rules as `readFile`.

### Code review

- `getMergeRequest` adds `headSha` from `sha` (falling back to `diff_refs.head_sha`).
- `getMergeRequestDiff` uses the newest merge request version, so `refs` (`base_commit_sha`, `start_commit_sha`, `head_commit_sha`) and files always belong together. Right after a merge request is created GitLab has no version yet; then `diff_refs` and the paginated `/diffs` endpoint are used. Status: `new_file` → `added`, `deleted_file` → `deleted`, `renamed_file` → `renamed`, else `modified`. `binary` is set when the diff is `Binary files … differ` or a `GIT binary patch`; `collapsed` is set when GitLab sends `collapsed` or `too_large` (GitLab 18.4+ on the versions endpoint), and `diff` is then empty.
- `compareCommits` compares the two commits directly (`straight=true`, `from..to`), not from their merge base. When GitLab hits its compare limits (`compare_timeout`) the list may be incomplete.
- `listDiscussions` maps each note's `author.username`, `body`, `created_at` and `system`. A discussion is `resolvable` when any note is, `resolved` when all resolvable notes are. `position` comes from the first diff note: `new_line` and `new_path` when set (`side: 'new'`), otherwise `old_line` and `old_path` (`side: 'old'`); image and file positions have no line and are left out.
- `submitReview`:
  1. `event: 'approve'` approves first with `sha: refs.headSha`. A refused approval (401/403 not an eligible approver, 409 the head moved, 401 when re-authentication is required) rejects with `GitLabApiError` before anything is posted.
  2. Comments are checked locally: `startLine` after `line`, a suggestion on `side: 'old'`, or a suggestion over more than 101 lines (GitLab allows 100 above the commented line) go to `failed` without a request; so do paths that are not in the diff.
  3. The diff of the version whose shas equal `refs` (else the newest) is read to place each line. Positions are `position_type: text` with `base_sha`, `start_sha`, `head_sha`, `old_path`, `new_path` and, per GitLab's rules, `new_line` for an added line, `old_line` for a removed one and both for an unchanged one (also outside the hunks, shifted by the hunks above). With `startLine < line` a `line_range` is added whose `start` and `end` carry `line_code` (`<sha1(new_path)>_<old>_<new>`, using GitLab's line counters, so an added line has the old number of the line after it), `type` (`new` for an added line, otherwise `old`) and the line numbers; the note itself sits on `line`. Without a diff body (collapsed) the line is sent on its side only.
  4. `summary` becomes a general draft note created before the comment drafts, then one draft per comment. A draft GitLab refuses (for example 400 for a line outside the diff) goes to `failed` with GitLab's message.
  5. `POST .../draft_notes/bulk_publish` publishes everything at once, so the author gets one notification; `request_changes` sends `reviewer_state: requested_changes`, which sets the reviewer state on GitLab versions that support it and is harmless otherwise. `approve` and `comment` send no reviewer state. `request_changes` with no comments and no summary still calls `bulk_publish` to set the state.
  6. When `bulk_publish` fails, each draft is published on its own (`PUT .../publish`, a 404 counts as already published); a draft GitLab rejects then is deleted and reported in `failed`. The summary is published last; `reviewer_state` is retried once with a final `bulk_publish`, ignoring its failure.
     `bulk_publish` publishes all pending drafts of the token's user, so leftovers from another tool would go out with the review; use a dedicated bot token. `posted` counts published comments, not the summary.
- Suggestions render as GitLab expects: the comment body, a blank line, then a fence, `suggestion:-N+0` with `N = line - startLine` (lines above the commented line that the replacement covers, `0` for a single line), the replacement and the closing fence. The fence is three backticks, or one more than the longest backtick run in the replacement, so code blocks inside survive (GitLab 17.7+ renders them). An empty replacement deletes the lines; one trailing newline of the replacement is dropped.
- `replyToDiscussion` adds a note to the thread; `resolveDiscussion` sends `resolved` as a query parameter. Resolving needs the Developer role or authorship of the merge request.

Failures are `GitLabApiError` with `status` and a message like `GitLab POST /api/v4/projects/g%2Fa/repository/commits failed with 400: A file with this name already exists`; the token is redacted, malformed bodies are reported by field names, and redirects are refused as for rotation.

### Webhooks

`ensureWebhook` uses `/groups/:id/hooks` for group targets and `/projects/:id/hooks` for projects, finding an existing hook by URL (then `PUT`, else `POST`) and setting every event flag explicitly plus `enable_ssl_verification: true`; the secret goes into `token`. Group hooks need GitLab Premium: when GitLab answers 404 or 403 for them, it registers a project hook on every non-archived project of the group (subgroups included) and says so in `fallback`. `removeWebhook` deletes hooks and ignores 404. The token needs the `api` scope and Maintainer (project hooks) or Owner (group hooks). `withFetch(wrap)` returns `gitlab({ ...options, fetch: wrap(fetch) })`.

## Token rotation

```ts
import { gitlabTokenRotator } from '@holtkeeper/forge-gitlab'

const rotator = gitlabTokenRotator() // options: { fetch?, now? }
```

A `TokenRotator` with kind `gitlab`. `url` is the GitLab base URL, with or without a trailing slash, including the path prefix of a self-managed instance (`https://example.com/gitlab`). Requests authenticate with the `PRIVATE-TOKEN` header and use the token's own `self` endpoints, so no admin token is needed:

| Method    | Request                                                                    | Result                                  |
| --------- | -------------------------------------------------------------------------- | --------------------------------------- |
| `inspect` | `GET /api/v4/personal_access_tokens/self`                                  | `name`, `scopes`, `expiresAt`           |
| `rotate`  | `POST /api/v4/personal_access_tokens/self/rotate` with `expires_at` (date) | new `token` and `expiresAt` from GitLab |

`expires_at` is today (UTC) plus `lifetimeDays`, as `YYYY-MM-DD`. GitLab tokens stop working at 00:00 UTC on that date, so `expiresAt` is reported as that instant. The instance's maximum token lifetime still applies; a longer request fails with 400.

Responses are validated; failures are `GitLabApiError` with `status` and a message like `GitLab POST /api/v4/personal_access_tokens/self/rotate failed with 401: 401 Unauthorized`. The token is never part of a message, and a malformed success body is reported by field names only, since it may contain the new token. `signal` is passed to `fetch`. Redirects are refused, because `fetch` would forward the `PRIVATE-TOKEN` header to another origin.

## GitLab facts (checked against the REST API docs, October 2026)

- Merge request versions are listed newest first; `GET .../versions/:version_id` returns all diffs of that version without pagination, `GET .../diffs` is paginated (`page`, `per_page`). `/changes` is deprecated since 15.7.
- Draft notes: `POST .../draft_notes` takes `note` and `position` (same fields as discussions, including `line_range`); `bulk_publish` takes optional `note`, `internal` and `reviewer_state` (`requested_changes` or `reviewed`, not an approval).
- Approve: `POST .../approve` with optional `sha` (409 when it is not the head) and `approval_password`.

- Self-rotation needs the `api` or `self_rotate` scope on the token itself.
- Rotation immediately revokes the old token and returns `200` with the new `token`. Without `expires_at` the new token expires in one week when expiry is enforced.
- If an already revoked token is used to rotate, GitLab revokes every active token of that token family (automatic reuse detection). Never rotate the same token from two places, and store the new token before anything else.
- Status codes: `400` not rotated, `401` token missing, expired, revoked or no access, `403` token may not rotate itself, `405` not a personal access token.
- Project and group access tokens have their own self-rotation endpoints: `POST /projects/:id/access_tokens/self/rotate` and `POST /groups/:id/access_tokens/self/rotate` (same scopes, same `expires_at`). The docs do not say that the personal access token endpoint accepts them, and this rotator does not call the project or group endpoints yet. Use a personal access token (for example of a service account) for rotated credentials; a `405` error says so.
