# @holtkeeper/propagate

Rolls package updates out across the repositories of a group. For each repository it plans through the forge API, bumps manifests and the lockfile in a writable checkout, runs the repository's checks and opens (or updates) one merge request per repository. It never runs an agent itself: repositories whose checks fail are handed to [write tasks](../../write-task/docs/README.md), one task group per run, that carry the bump as a patch.

## Flow

```
plan (forge API) ─► checkout ─► bump ─► verify ─┬─ pass ─► publish ─► outcome
                                                 └─ fail ─► fix task (bump patch + prompt), or a draft
```

1. **Plan** (`Planner`, `createPlanner`): reads the root `package.json`, its workspaces (`workspaces` or `pnpm-workspace.yaml`; globs need `GitForge.listFiles`), `pnpm-workspace.yaml` catalogs and overrides, `go.mod` and `go.work` modules — no clone. Every declaration becomes a `Usage` with its key path, declared range, range floor (`current`) and the value the bump will write (`next`). Repositories without declarations are `skipped`; those whose ranges already start at or above the target are `unchanged`. `latest` is resolved once per wave through a `VersionRegistry` (`createHttpRegistry`: npm registry, Go proxy).
2. **Bump** (`Bumper`: `npmBumper`, `goBumper`): edits manifests in place, keeping every other byte, and keeps the range style — `^1.2.3` → `^2.0.0`, `~1.2` → `~2.0.0`, exact stays exact, `>=1` → `>=2.0.0`, compound ranges become `^2.0.0`. Handled: `dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies`, npm/bun `overrides` (nested too), `pnpm.overrides`, yarn `resolutions`, bun catalogs (`catalog`, `catalogs`, also under `workspaces`) and pnpm catalogs in `pnpm-workspace.yaml`. `catalog:` references are bumped at their catalog, `workspace:` and other protocols are left alone, nothing is ever downgraded. The lockfile is regenerated with the repository's package manager (`detectPackageManager`, `lockfileUpdateCommand` from `@holtkeeper/vuln-js`). Go runs `go get <module>@<version>` and `go mod tidy` with `GOTOOLCHAIN=local`.
3. **Verify** (`Verifier`, `detectChecks`, `createCommandVerifier`, `verifyCheckout`): `install` (when another JavaScript check needs `node_modules`), then `typecheck` (script `typecheck`, `type-check` or `tsc`), `lint`, `test`, `build` run through the package manager, and `go build ./... && go test ./...` for Go bumps. Each runs as `sh -c` with `CI=1`; results keep the exit code, the last 200 output lines and the duration. A failing `install` stops the run.
4. **Fix tasks** (`FixProposer`, `fixPrompt`): when checks fail, release notes come from a `ReleaseNotesSource` chain — the installed `node_modules/<pkg>/CHANGELOG.md` sections in `(old, new]` plus `MIGRATION.md`/`UPGRADING.md`, then the package's source repository when `sources` maps it (changelog at the target tag via `listTags` + `readFile`, else the tag names). The bump becomes a binary-safe patch (`git diff --cached --binary` of the bump's files) and a prompt with the rules (never edit lockfiles, change versions or downgrade), the bumps, the failing output and the notes, at most 19 000 characters. After the wave, all of them go to `fixes.propose` at once: the server turns them into one `propagate-fix` task group, proposed and waiting for a person's approval (see [apps/server](../../../apps/server/docs/README.md)). Such repositories get no merge request from the wave; the write task opens one with the bump and the fix. A bump patch over 1 000 000 characters falls back to a draft.
5. **Publish** (`changedFiles`, `publishChanges`, `describeMergeRequest`, `mergeRequestBody`): only the files the bump changed are committed — build output and `node_modules` never are. The commit goes through the forge API to `<branchPrefix>/<pkg-slug>-<version>`; an open merge request for that branch is updated (files already identical there are skipped), otherwise one is opened against the default branch. The description lists the bumps, a check table, failing output and the release notes. Failing checks without a fix task give a draft labeled `needs-attention`. Nothing is published without a changed manifest, or with `dryRun`.

## Analyzer

`propagateAnalyzer` (kind `propagate`, analysis `propagation`, scope `group`, `exclusive`, needs `forge`, no agent) and `createPropagateAnalyzer({ fixes?, registry?, steps?, testsExpected? })`: `fixes` is the `FixProposer` the server injects; without it failing repositories get drafts. `testsExpected(repo)` (the server reads `repo.tests`) marks repositories with no tests by design: `runPropagation` verifies them with `withoutTests(checks)` (`{ test: false, go: 'go build ./...', ...checks }`), and their fix tasks get the write task policy's `noTests`. It needs `context.checkout` and `context.repos` from the runner.

| Option                        | Default                         | Meaning                                                                               |
| ----------------------------- | ------------------------------- | ------------------------------------------------------------------------------------- |
| `packages`                    | required                        | `{ name, version: exact \| 'latest', ecosystem?: 'npm' \| 'Go' }[]`                   |
| `onlyRepos`                   | all                             | Repository path globs (`games/*`, `**/web`)                                           |
| `checks`                      | detected                        | `{ install, typecheck, lint, test, build, go }`: a command replaces, `false` disables |
| `allowInstallScripts`         | `false`                         | Run lifecycle scripts during lockfile updates and installs                            |
| `fixTasks`                    | `true`                          | Propose write tasks for failing repositories when a proposer is injected              |
| `mergeRequest.draftOnFailure` | `true`                          | `false`: no draft for failing repositories without a fix task                         |
| `mergeRequest.labels`         | `['holtkeeper','dependencies']` |                                                                                       |
| `mergeRequest.branchPrefix`   | `holtkeeper/update`             |                                                                                       |
| `sources`                     | `{}`                            | Package → `forge:path` of its source repository, for release notes                    |
| `concurrency`                 | `2`                             | Repositories processed at once                                                        |
| `dryRun`                      | `false`                         | Bump and verify, but publish and propose nothing                                      |

`runPropagation(input)` is the same pipeline without the analyzer wrapper. `propagateLocal({ dirs, packages, checks?, runner, registry?, steps? })` runs plan → bump → verify on local directories in place and never publishes or proposes — for tests.

## Data and report

`PropagationData`: `{ group, packages: PackageTarget[], dryRun, repos: RepoOutcome[], releaseNotes, fixGroup? }`. Each `RepoOutcome` has `status` (`unchanged`, `skipped`, `updated`, `failed`, `error`), `usages`, `bumps` (`{ package, from, to, manifest }`), `checks`, `changedFiles`, `fixTask` (the proposed write task), `mergeRequest` (`{ id, url, draft }`), `notes` and `error`.

The report shows repositories targeted, updated cleanly, fix tasks, failed, skipped/unchanged and merge requests; deltas are against the previous wave of the same package names. Sections: **Wave overview** (stacked bar by status, table repo × status with the previous wave's status, fix task and merge request links), **Failures** (issues with failing output excerpts, linking the fix task when there is one), **Release notes used**, **Plan** (every declaration and what it was bumped to). Fix task links are panel paths to Ops › Tasks (`webPaths.tasks({ group, task })` of [@holtkeeper/web-paths](../../web-paths/docs/README.md)).

## Reusable steps

The verify and publish steps take no propagation-specific types, so other packages drive them with their own context:

- `detectChecks`, `createCommandVerifier`, `defaultVerifier`, `verifyCheckout` → `CheckSpec`, `CheckResult`
- `changedFiles`, `snapshot`, `publishChanges({ forge, repo, dir, files, branch, title, description, labels, draft?, failed?, attentionLabel?, targetBranch?, mode?, git? })`, `describeMergeRequest({ sections?, checks, details? })`

## Safety

- **Install scripts** are off by default: lockfile updates and installs run with `--ignore-scripts` (yarn berry: `YARN_ENABLE_SCRIPTS=false`), so a malicious or broken package cannot run code on the runner during the bump. Checks themselves run the repository's own scripts, as its CI would; run the task engine in a container when repositories are not trusted.
- **No agent here**: fixes run as write tasks on the write worker pool, only after a person approves the group, with the write task's sandbox and a spend cap of $1.50 per repository within $5 per group (`tasks.write`).
- **Drafts**: repositories whose checks fail without a fix task get a draft merge request labeled `needs-attention` with the failing output, never a ready one; set `draftOnFailure: false` to skip them instead. Nothing is merged automatically.
- **No noise**: a repository is published only when a manifest actually changed; build output, `node_modules` and files nobody intended to change stay out of the commit.

## Limitations

- An existing branch without an open merge request is committed onto as if it started from the default branch; delete stale branches first.
- Go release notes come only from `sources`; Go workspaces are read from `go.work`, not discovered.

## Publish modes

`publishChanges` takes `mode: 'api' | 'git'` (default `api`):

- `api` commits through `forge.commit` (the GitLab Commits API) on top of the branch; nothing is pushed from the checkout. Such commits **cannot carry our signature**: GitLab creates them server-side, and depending on instance settings may sign web and API commits with its own key, never with ours.
- `git` commits in the checkout and pushes the branch through `git` (a `GitPublisher`, which `GitCheckout` from `@holtkeeper/workspace` satisfies), then opens or updates the merge request through the API. The commit is signed when the checkout was created with `signing`, and the push goes over SSH when it was created with `ssh`. The branch is replaced with one commit on top of the checkout's base (`--force-with-lease`, so a branch moved by someone else is not overwritten); when it already holds the same tree the push is skipped. Signed commits require `mode: 'git'`.

`runPropagation` publishes in `git` mode when the checkout carries a `publisher` (the task engine adds one when the forge has a signing key, see [@holtkeeper/jobs](../../jobs/docs/README.md#context)), otherwise in `api` mode.
