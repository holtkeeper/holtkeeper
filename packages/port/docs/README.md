# @holtkeeper/port

Ports a change made in one repository — a merge request, a list of commits or a commit range — to the sibling repositories of a group. Per target it checks whether the change is needed, applies the source patch (as is, then with remapped paths), lets an agent re-implement it when the patch does not fit, runs the target's checks, fixes what breaks and opens one merge request per repository. Finally it comments on the source merge request with a table of the results.

## Flow

```
load source ─► per target: checkout ─► triage ─┬─ already-present / not-applicable ─► outcome
                                                └─ apply --3way ─┬─ clean / remapped ─┐
                                                                 └─ adapt (agent) ────┴─► verify ⇄ fix ─► publish
after all targets: comment on the source merge request
```

1. **Load** (`SourceLoader`, `defaultSourceLoader`): a merge request comes from the forge (`getMergeRequest`, `getMergeRequestDiff`; pre-images of changed files through `readFile` at the diff's base commit). Commits and ranges come from a read-only checkout of the source (`git show` / `git diff --binary -M`, pre-images via `git show <base>:<path>`), or from `compareCommits` when no checkout is available. Issue references (`#12`, `GTW-435`, issue URLs) are collected from title and description. `intentSummary` builds a deterministic summary: title, source, issues, description, and every file with its line counts and hunk headings.
2. **Triage** (`Triage`, `ruleTriage`, `agentTriage`): in the writable checkout of the target. `already-present` when the patch (or its path-remapped form) reverses cleanly, or when every distinctive added line exists and no distinctive removed line remains (`git grep -F`). `not-applicable` when none of the touched files exists by path or name and none of the changed symbols occur (`git grep -w`). Mixed evidence is `unclear`: with an agent, it is asked with `taskKind: 'triage'` (read and search only) and answers `apply`, `already-present` or `not-applicable` with a reason; without one the pipeline proceeds.
3. **Apply** (`PatchApplier`, `defaultPatchApplier`): the source pre-images are written into the target's object store and referenced by `index` lines, so `git apply --3way` performs a real three-way merge in a repository that never had those blobs. First with unchanged paths (`clean`), then with paths remapped (`remapped`, `remapPaths`): a missing file maps to the tracked file of the same name with the longest common path suffix (ties are not mapped), and new files follow the directory moves those mappings imply. A failed or conflicting apply resets the checkout.
4. **Adapt** (`Adapter`, `createAgentAdapter`): the agent (read, search, edit, run; `taskKind: 'port'`; code tools when injected as `toolsets`) gets the intent, the source diff, git's apply output with the conflicting files, and `git grep -n` locations of the changed symbols. It answers `{ status: 'ported' | 'not-applicable' | 'already-present' | 'failed', summary, changes, deviations }`. Anything but `ported` resets the checkout. Without an agent a patch that does not apply makes the target `failed`.
5. **Verify + fix**: `verifyCheckout` with the configured `checks` (Go checks when the target has `go.mod`), then `fixUntilPassing` from `@holtkeeper/propagate` with the intent and source diff as context and instructions to keep the fix minimal and never revert the port.
6. **Publish**: `publishChanges` commits the ported files plus files the fixer touched to `<branchPrefix>/<source-slug>` (`core-mr-12`, `core-<sha8>`, `core-<from8>-<to8>`) and opens or updates the merge request `Port: <source title>`. The description (`mergeRequestDescription`, built on `describeMergeRequest`) links the source, lists issues, the method, remapped paths, the agent's summary, deviations, the check table, fixer report and the collapsed source diff. Failing checks give a draft labeled `needs-attention`, or no merge request with `draftOnFailure: false`.
7. **Comment** (`sourceComment`): when `commentOnSource` and the source is a merge request, one comment with a row per target: outcome (with reason) and merge request link. A failing comment is recorded in `sourceComment`, never thrown.

Outcomes per target: `ported-clean`, `ported-remapped`, `ported-adapted`, `already-present`, `not-applicable`, `failed` (patch did not apply without an agent, the agent failed, or checks fail after the port — `method` then says how far it got), `error` (unexpected exception, e.g. checkout).

## Analyzer

`portAnalyzer` (kind `port`, analysis `port`, scope `group`, needs `forge`, agent `optional`) and `createPortAnalyzer({ steps?, toolsets? })` to replace steps or mount agent code tools (e.g. from `@holtkeeper/agent-tools`). It needs `context.checkout` and `context.repos`; when a checkout carries its own `runner`, commands for it run there.

| Option                        | Default                   | Meaning                                                                                  |
| ----------------------------- | ------------------------- | ---------------------------------------------------------------------------------------- |
| `source`                      | required                  | `{ repo: 'forge:path', mergeRequest? \| commits? \| range?: { from, to } }`, or a string |
| `targets`                     | group minus the source    | Repository globs or group names                                                          |
| `checks`                      | detected                  | `{ install, typecheck, lint, test, build, go }`: a command replaces, `false` disables    |
| `fix.enabled`                 | true when an agent exists |                                                                                          |
| `fix.maxAttempts`             | `3`                       |                                                                                          |
| `fix.maxTurns`                | `40`                      | Per attempt                                                                              |
| `fix.timeoutMinutes`          | `20`                      | Per attempt                                                                              |
| `mergeRequest.branchPrefix`   | `holtkeeper/port`         |                                                                                          |
| `mergeRequest.labels`         | `['holtkeeper','port']`   |                                                                                          |
| `mergeRequest.draftOnFailure` | `true`                    | `false`: no merge request while checks fail                                              |
| `commentOnSource`             | `true`                    | Comment the results table on the source merge request                                    |
| `concurrency`                 | `2`                       | Targets processed at once                                                                |
| `dryRun`                      | `false`                   | Triage, port, verify and fix, but publish and comment nothing                            |

The source must be on the group's forge; a bare path means that forge.

### Command form

`/holtkeeper port <targets…> --source <spec>` passes the positional arguments as `targets` (a string is split on commas and spaces). `source` accepts `repo!12` (merge request), `repo@sha1,sha2` (commits) and `repo@from..to` (range) — `parseSourceSpec`. Target arguments resolve through `resolveTargets`:

- a glob (`games/*`, `**/web`) matches repository paths of the group;
- a repository path selects that repository;
- the group's own name (`context.repo.path`) selects every repository of the group;
- another bare name is a namespace: `games` becomes `games/*` when group repositories live under it, otherwise the forge's `listRepositories('games')` adds that namespace's repositories.

The source repository is never a target.

## Data and report

`PortData`: `{ group, source, branch, dryRun, targets: TargetOutcome[], sourceComment? }`. `source` holds the repo, kind and id, title, description, link, issues, `intent` and the files with line counts and (trimmed) diffs — no pre-images. Each `TargetOutcome` has `outcome`, `method`, `reason`, `triage` (`{ verdict, reason, by: 'rules' | 'agent', symbols }`), `remapped`, `adapt`, the latest `checks`, `fix` (`{ attempts, report, files }`), `changedFiles`, `diffStat`, `mergeRequest`, `notes`, `error`.

Metrics: targets, ported, applied cleanly, paths remapped, adapted by agent, skipped, failed, merge requests; deltas against the previous port of the same source (same repository and merge request, commits or range). Sections: **Overview** (stacked bar by outcome; table with outcome, previous run's outcome, method, checks, diff stats and merge request links), **Adaptations** (remapped paths, agent summary, changes, deviations, check fixes, diff stats), **Skipped** (reason and whether rules or the agent decided), **Failures** (failing check output excerpts, port failures, errors), **Source change** (intent summary and the source diff as a `changes` block with `applicable: false`).

## Safety

- The agent works only in the private writable checkout; triage is read and search only. Each run has a turn limit and a timeout.
- Nothing is merged; failing ports become drafts labeled `needs-attention`. Only files the port and the fixer changed are committed.
- Checks run the target's own scripts, as its CI would; run the task engine in a container when repositories are not trusted.

## Limitations

- Binary files are ported only when the source patch carries a git binary patch (commits and ranges from a checkout); merge request diffs from the forge do not, so binary files are skipped with a note.
- Pre-images are read for at most 100 files; beyond that `--3way` falls back to direct application.
- Mode changes are not ported; renames are applied as renames only where the target has the old path (or a remapped one).
- Several commits are applied as one patch in order; a file changed by several commits gets one patch section per commit.
