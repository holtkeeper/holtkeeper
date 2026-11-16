# @holtkeeper/qa

Tasks for testers: what changed under each ticket key across repositories, which test attributes the changes add or remove, and, only when a person asks, an AI summary with test cases, ideas per kind of testing, autotest ideas and risks. Everything is read from `GitForge` on demand; nothing is tracked per push and nothing is written to a forge.

## Model

A **change** (`QaChange`) is one way code reached a tracked branch:

| `kind`               | What                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| `merge-request`      | a merged merge request (merge commit, squash or fast-forward)                                   |
| `open-merge-request` | a merge request into a tracked branch that is not merged yet: it can be tested before the merge |
| `commit`             | a commit pushed to the branch without a merge request: nobody reviewed it                       |
| `merge`              | a merge commit made outside the forge (`git merge` and push), also without a review             |

A change has its ticket keys (`keys`, from the merge request title, its source branch and the commit messages through `ticketKeys` of [@holtkeeper/commit-conventions](../../commit-conventions/docs/README.md); never from descriptions, which often mention other tasks), its commits and the range `base..head` its diff covers. A **task** (`QaTask`) is a key with every change that names it, across repositories, newest first. A change naming two keys belongs to both.

## Reading history

`readRepoHistory({ forge, repo, defaultBranch, branches, since, now, previous? })` reads what `branches` hold since `since` (`QaRepoHistory`): their commits (at most `QA_COMMIT_CAP`, 1000, per branch; `capped` says more were left out) and the merge requests merged into them in the period plus every open one. Given the previous read of the same repository it reads only what is new:

- a branch whose head did not move costs one request;
- a branch that moved on reads the commits since its old head (`listCommits` with `since`);
- a branch that was rewritten (the new commits do not continue the old head) is read again in full (`listCommits` with `after`);
- merge requests are read from the previous read on, five minutes overlapping for clock skew;
- merge requests merged without a merge or squash commit (fast-forward) get their commits through `listMergeRequestCommits` once (at most 40 per read) and keep them while their head stays.

Branches that do not exist are skipped. Messages and descriptions are kept up to 4000 characters.

`changesOf(history)` turns a history into changes. It walks each branch's first-parent line oldest first and attributes every commit to the merge request whose merge commit, squash commit, commits or head it is; a merge commit with no merge request is a `merge` (its side commits come with it), any other commit a `commit`. Merges whose source is another tracked branch (release candidates, back-merges) are not changes of their own, and a commit already counted on an earlier branch is not counted again, so the order of `branches` matters: the branch where work lands first. Open merge requests whose source is not tracked become `open-merge-request` changes.

`groupTasks(changes, { isCatchAll?, issues? })` groups changes by key and counts `untracked` changes: those without a key, or with only keys `isCatchAll` matches. `taskTitle` names a task without a tracker issue: its newest merge request title, else the title its commits repeat most. `changesSince(changes, since)` narrows to a period.

## Change details

`changeDiff(forge, change)` reads the diff of one change: the merge request's latest diff while it is open, else `compareCommits(base, head)`. `changeDetail(files, attributes)` keeps what a page shows (`QaChangeDetail`): files with line counts (at most 300; `partial` when more changed or the forge left diffs out) and the test attributes added and removed per file. `testIdsIn(text, attributes)` finds attribute values in templates: quoted, bound (`:data-testid`, `v-bind:`, `[attr.data-testid]`), JSX literals and expressions (`dynamic`); a value both added and removed in a file is neither. Attribute names come from the `analyzers.testids` setting (`attributes`), else `defaultAttributes` of [@holtkeeper/testids](../../testids/docs/README.md). `diffExcerpt(files, { budget?, perFile? })` is what the agent reads: source files first, each cut to `perFile`, lockfiles, generated, binary and asset files by name only.

## Summary

`summarizeTask(agent, { key, title, issue?, changes, diffBudget?, language?, signal? })` asks the agent once, in `language` (English by default; test attribute values and technical terms stay as they are), (task kind `qa-notes`, tier `main`, no tools and no repository access, three turns at most) for `QaSummarySections`:

- `overview`, `changes` — what changed, in product language without identifiers;
- `verdict` (`must`, `should`, `optional`) and `verdictReason`;
- `testCases` with priority, steps and the expected result;
- `testing` — ideas per kind (manual, e2e, integration, unit, api, regression, exploratory, visual, performance, accessibility);
- `autotests` with their level and the test attribute values they could use (only values the changes added are kept);
- `risks` and open `questions`.

The Guide's `testing` section reaches the agent as context of the `qa-notes` task kind, so team conventions win. Unreviewed changes are pointed out as riskier.

`summaryInputs(changes)` is what a summary was written from: one `<forge>:<path>!<id>#<head>` (merge requests) or `<forge>:<path>@<short sha>#<head>` (commits) per change. `staleness(inputs, changes)` compares them with the current changes: `added`, `removed` and `updated` (an open merge request moved on), each as `changeIdentity` values, or `undefined` while the summary is current.

## Setting

`qa` (`qaSettingsDefinition`, section Releases, scoped like every repository setting; a narrower entry replaces a broader one as a whole):

| Field          | Default                  | Meaning                                                                                                                                                                                  |
| -------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`      | `true`                   | The repository is read for Releases › QA                                                                                                                                                 |
| `branches`     | —                        | Branches whose changes count, work branch first (at most 10); without it the release flow's source and target (target alone in trunk mode) when releases are on, else the default branch |
| `catchAllKeys` | `['[A-Z][A-Z0-9_]*-0+']` | Placeholder keys such as `ABC-000`: regular expressions (at most 50, 200 characters each) that must match the whole key, case-sensitive; such keys are ignored                           |
| `language`     | —                        | Language of the AI test notes; unset, the server uses the review language (`analyzers.review` › `language`), else English                                                                |

A change naming a real key and a placeholder counts for the real key only. `qaSettings(value)` never throws (an invalid value gives the defaults) and `catchAllMatcher(patterns)` skips invalid patterns.

## Open points

Changes without a task are counted but not listed; see the plan's open questions.
