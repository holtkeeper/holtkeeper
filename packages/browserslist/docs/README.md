# @holtkeeper/browserslist

Keeps the browserslist database (`caniuse-lite`) current: runs `update-browserslist-db` through each repository's package manager and proposes the lockfile change as a merge request that shows which browsers the targets gained or lost.

## Analyzer

`createBrowserslistAnalyzer({ conventions? })` builds it; `conventions(repo)` returns the repository's `CommitConventions` (the server passes its `commitConventionsReader`). `browserslistAnalyzer` is the one without conventions. Kind `browserslist`, scope `repo`, `exclusive`, needs `forge`. `appliesTo` is `lockfileHasPackage('caniuse-lite')`, so schedules queue it only for repositories whose root lockfile resolves `caniuse-lite`; the default `browserslist-weekly` schedule of `@holtkeeper/managed-config` runs it on Tuesday nights across every group. The server never queues it automatically on a repository `repo.freeze` makes read-only, unless `dryRun` is set for it.

1. Checks out the default branch writable and finds the root lockfile (`bun.lock`, `pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`) that resolves `caniuse-lite`; without one the result is `not-applicable`.
2. Unless `dirs` is empty, installs from the frozen lockfile and resolves the browsers of each directory with the project's own `browserslist`.
3. Runs the update: `bunx`, `pnpm dlx`, `yarn dlx` (berry) or `npx --yes` (npm, yarn classic) `update-browserslist-db@latest`, or `command`.
4. No changed file: `up-to-date`. Otherwise installs again, resolves the browsers after, picks the commit message (see below) and commits the changed files (never `node_modules`) to `branch`, opening a merge request against the default branch or updating the open one. Commits are signed and pushed over git when the forge has a signing key. With `autoMerge` it then asks the forge to merge once the checks pass (GitLab auto-merge: right away when nothing blocks the merge, otherwise after the pipeline and the required approvals), retrying twice 10 s apart while GitLab still checks a new merge request; a refusal is recorded, not a failure.

### Commit message

`browserslistCommit({ version, branch, conventions?, configured? })` picks the commit message, which is also the merge request title: the first candidate that breaks no error-level rule of the conventions (setting `commits.conventions`, push rules, commitlint; history only warns). Candidates, `{version}` replaced: `commitMessage` when set, the conventions' `template` (`<type>`, `<scope>`, `<subject>`; `<TICKET>` dropped), then `<type>(deps): <subject>`, `<type>: <subject>` and, unless titles must be conventional, a plain capitalized subject, each with the long subject `update browserslist database to caniuse-lite {version}` and the short `update caniuse-lite to {version}`. The type is `build`, else `chore`, else the first type the conventions allow (`commitType`); `deps` is dropped when the allowed scopes leave it out; the subject is capitalized when they ask for it. Without conventions the first candidate is used, by default `chore(deps): update browserslist database to caniuse-lite {version}`.

When no candidate qualifies, most often because a ticket key is required, or when the forge's push rules reject `branch`, nothing is committed or pushed: the result stays `updated` with `skipped` saying why (and how to fix it: a `commitMessage` with a ticket key, another `branch`), and the job succeeds.

Lifecycle scripts stay off (`--ignore-scripts`, `npm_config_ignore_scripts`, `YARN_ENABLE_SCRIPTS=false`) unless `allowInstallScripts`. A failing update is a result (`failed`, with the output tail), not a job failure; a failing install only leaves the browser lists unknown.

| Option                | Default                          | Meaning                                                                          |
| --------------------- | -------------------------------- | -------------------------------------------------------------------------------- |
| `command`             | by package manager               | Shell command that updates the database                                          |
| `dirs`                | `['.']`                          | Directories whose browsers are compared; `[]` skips the installs                 |
| `allowInstallScripts` | `false`                          | Run dependency lifecycle scripts                                                 |
| `timeoutMinutes`      | `15`                             | Per command                                                                      |
| `branch`              | `holtkeeper/browserslist`        | Branch of the merge request                                                      |
| `commitMessage`       | from the commit conventions      | Preferred commit message and merge request title; `{version}` is the new version |
| `labels`              | `['holtkeeper', 'dependencies']` |                                                                                  |
| `autoMerge`           | `false`                          | Merge the merge request once its checks pass                                     |
| `dryRun`              | `false`                          | Update and report, publish nothing                                               |

## Data and report

`BrowserslistData`: `status` (`not-applicable`, `up-to-date`, `updated`, `failed`), `lockfile`, `packageManager`, `caniuse-lite` versions `before`/`after`, `targets` (browsers per directory before and after), changed `files`, `mergeRequest` (with `autoMerge`: `set` or `failed`), `dryRun`, `skipped` (why an update was not published), `output`. `browserslistAnalysis` renders the status, the database version, the `skipped` reason, a table of added and removed browsers and the command output. `targetChanges(targets)` gives the added and removed browsers; `caniuseVersions(text)` reads the versions from lockfile text.
