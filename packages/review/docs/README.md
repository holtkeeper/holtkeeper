# @holtkeeper/review

AI code review of merge requests: the `review` analyzer reviews one merge request, posts inline comments (with one-click suggestions) and a summary, resolves its own threads once fixed, and answers replies in its threads. It talks to the forge only through `GitForge` and to the LLM only through `Agent`.

## Flow

`reviewMergeRequest(run)` runs replaceable steps (`ReviewSteps`, override any of them with `run.steps`):

1. **load** — `getMergeRequest`, `getMergeRequestDiff`, `listDiscussions`, and the previous review from history: the newest `review` record with `ref` `!<iid>` that reviewed something.
2. **plan** — reads the repository guidelines (and the path rules from REVIEW.md), decides the mode and scopes the diff: added lines of reviewable files, minus `ignore` globs (plus globs from REVIEW.md, see below). Deleted, binary and forge-collapsed files are skipped. Incremental: `compareCommits(lastHead, head)` intersected with the MR diff; only lines both add are in scope.
3. **deterministic** — with `includeChecks`, runs the injected quality checks (`lint`, `secrets`, `conventions`, `testids`) on the checkout and keeps issues touching lines in scope. A fix whose edits lie entirely on changed lines becomes the comment's suggestion. Findings of `agentCompletedChecks` (`testids`: interactive elements added without a test attribute) go to the agent instead when there is one: the prompt lists them with the project's convention, the agent comments on the ones it agrees with and suggests the attribute in the project's style, and the rest are dropped. Without an agent they are posted as found.
4. **agentReview** — one structured agent task (`taskKind: 'review'`): the system prompt holds the rules; `context` holds REVIEW.md, CLAUDE.md, AGENTS.md, CONTRIBUTING.md (trimmed: 6 000 characters per file, 12 000 in all), the `review.instructions` setting plus `options.instructions`, and knowledge entries; the prompt holds the MR title and description, the REVIEW.md path rules matching files in scope, open threads and the numbered diff per file (`+` in scope, `~` reviewed before, `-` removed). The agent reads more code with its tools instead of getting whole files. Besides comments it returns a summary, a verdict, a `walkthrough` (logical changes with their files) and `effort` (1–5, how hard the change is for a human to review).
5. **media** — images the diff adds or changes go to the injected `MediaReviewer` (see below).
6. **tests** — with the `tests` option, the injected `MergeRequestTester` writes and runs tests for the changed functions (see [Tests](#tests)). Its run goes into `data.tests` and under "Tests" in the summary; it adds no inline comments.
7. **validate and rank** — every comment must target a new-side line shown by the diff; a line outside it moves to the nearest changed line (at most 5 away) or is dropped; in incremental reviews lines reviewed before are dropped. Suggestions must cover exactly `startLine..line`: copies of neighbouring lines are trimmed, no-op suggestions dropped, broken ranges lose the suggestion. Findings repeating an open thread (same path, line within ±2, similar text) or a deterministic finding are dropped. The rest is filtered by `minSeverity`, sorted by severity and capped at `maxComments`.
8. **recheck** — our open threads whose file changed since the last review (all of them after a force push) are re-checked by the triage model (`taskKind: 'triage'`, at most 10 per run). Fixed ones are resolved with a short note, threads whose file left the diff are resolved too. A thread that is still relevant and that the agent raised again gets a "still applies" reply instead of a duplicate comment.
9. **post** — one `submitReview` with the comments and the summary note (verdict, agent summary, review effort, the walkthrough in a collapsed table, findings per severity, thread outcome, what was not reviewed), `event: 'approve'` when `approve: 'when-clean'` and the review is clean (verdict `looks-good`, no major/critical finding, no thread still open). Incremental runs without anything new post nothing. Rejected comments are marked in the data.

When the in-scope diff exceeds `maxDiffLines` the review is skipped with a summary note (posted once until the MR gets small enough).

Every note carries a hidden marker (`<!-- holtkeeper:review id=<finding> -->`); later runs and the webhook use it to recognize our threads, in addition to `botUsername`.

## Analyzer

`createReviewAnalyzer(deps)` / `reviewAnalyzer` — kind and analysis `review`, scope `repo`, needs checkout, forge, history and an optional agent. Without an agent only deterministic findings are posted and threads are not re-checked.

| Option            | Default                                  | Meaning                                                                                                                              |
| ----------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `mergeRequest`    | required                                 | MR number (iid)                                                                                                                      |
| `mode`            | `auto`                                   | `auto`: incremental when a previous review exists and its head is an ancestor                                                        |
| `maxComments`     | 15                                       | inline comments per run                                                                                                              |
| `minSeverity`     | `minor`                                  | `info`, `minor`, `major`, `critical`                                                                                                 |
| `includeChecks`   | `false`                                  | `true` or a list of `lint`, `secrets`, `conventions`, `testids` (or `lint,secrets`)                                                  |
| `approve`         | `never`                                  | `when-clean` approves clean reviews                                                                                                  |
| `ignore`          | lockfiles, generated, snapshots, dist, … | path globs (`DEFAULT_IGNORE`); globs without `/` also match base names                                                               |
| `maxDiffLines`    | 3000                                     | skip bigger diffs (added + removed lines in scope)                                                                                   |
| `language`        | the MR description's language            | language of comments                                                                                                                 |
| `instructions`    | —                                        | extra rules, appended after the `review.instructions` setting                                                                        |
| `media`           | `true`                                   | review images with the `MediaReviewer`                                                                                               |
| `replyTo`         | —                                        | discussion id: answer that thread instead of reviewing                                                                               |
| `releaseBranches` | `DEFAULT_RELEASE_BRANCHES`               | `source:target` branch globs of merge requests not reviewed (`develop:main`, `release/*:main`, `main:develop`, …); `[]` reviews them |
| `reviewOwn`       | `false`                                  | review merge requests authored by `botUsername`                                                                                      |
| `force`           | `false`                                  | review even what `releaseBranches` and `reviewOwn` skip (`/holtkeeper review force=true`)                                            |
| `tests`           | `false`                                  | write and run tests for changed functions with the `MergeRequestTester`                                                              |
| `maxTests`        | 2                                        | functions that get a test per run                                                                                                    |
| `testRepeat`      | 2                                        | runs on the head a test must pass                                                                                                    |
| `testTimeoutMs`   | 120000                                   | per test run                                                                                                                         |
| `testAttempts`    | 3                                        | rounds of writing and running before a test is `unfinished`                                                                          |
| `testComponents`  | `false`                                  | write tests for functions in component files (`.tsx`, `.jsx`) too                                                                    |

**Not reviewed by default.** Before any checkout, a merge request between `releaseBranches` (release candidates like `develop → main`, back-merges like `main → develop`: their code was reviewed on the way into the integration branch) or authored by `botUsername` (Holtkeeper's own update, propagation and test merge requests; compared case-insensitively, so it needs `jobs.botUsername`) is stored as `mode: 'skipped'` with the reason and nothing is posted. `force` overrides both; thread replies (`replyTo`) are never skipped. Set the options per repository or group through the `analyzers.review` setting.

**What the job should set:** `ref` = the MR head sha (the webhook does). The engine's mirror fetches every ref, so the head of fork MRs (`refs/merge-requests/<iid>/head`) resolves too. When the checkout is not at the head, the analyzer checks out the head itself through `context.checkout`.

`ReviewAnalyzerDeps`: `checks` (quality checks by name), `instructionsFor(repo)` (the scoped `review.instructions` setting), `knowledge: { access, groupsOf? }` (top entries for the MR go into the agent context and the `knowledge` toolset is mounted), `toolsetsFor` (review-specific tool sets; the host attaches the shared code tools), `mediaReviewer`, `tester` (a `MergeRequestTester`, e.g. from `@holtkeeper/review-tests`), `botUsername`, `steps`.

The record is stored with `ref` `!<iid>`.

## Conversations

`replyToThread({ forge, repo, mr, discussion, agent, dir?, botUsername?, language? })` answers the latest reply in a thread we started: `explain`, `concede` (and resolve) or `update` with a new suggestion (GitLab ` ```suggestion:-N+0 ` markup). Threads not started by us, and threads whose last note is ours, are skipped. With `options.replyTo` the analyzer runs it and stores a `reply` record.

**Learnings.** With a `learn` callback the agent may also return a `learning` when the reply states a lasting rule of the repository (a convention, a deliberate decision, something not to flag). `learn` gets it with the discussion and note ids; the result carries the outcome (`{ id, status, duplicateOf? }`, or `{ error }` — a failing `learn` never fails the reply). The analyzer wires `learn` to `knowledge.access.propose` when `knowledge` is configured (actor `agent:review`, body ending with a link to the note), so the rule becomes a `proposed` knowledge entry (or `accepted` under `knowledge.autoAccept`) and reaches later reviews once accepted. The thread entry of the record keeps it as `learning`.

## Tests

`MergeRequestTester.test(input)` gets the checkout at the head, the job's `CommandRunner`, the agent (its usage counts into the review's), the files in scope, the head sha, the MR title and description, the previous review's tests and the limits (`ReviewTestOptions`). It returns a `ReviewTestRun`: `items` (`ReviewTest`: target function with its text hash, test file, framework, command and `cwd`, `verdict`, runs passed on the head, attempts, the file `content`, `notes`, `reason`, the tail of the last failing run, `ranAt`), `notTested` (function and why) and `skipped` when no test was written at all. The contract: verdicts are what the runner observed, never the agent's claim; the checkout is left as it was found.

Verdicts: `passes` (passed every run on the head), `flaky` (only some), `unfinished` (never passed, or the agent judged the code wrong). Passing tests are the analysis' `changes`: a `create` edit with `base` set to the MR's source branch, so accepting one from the report opens a merge request into that branch (or a patch against it). Without a tester, agent or checkout the run is `skipped` with the reason.

The step runs project code (installs, tests): run reviews with it in a sandboxed runner (`exec-container`) or on isolated worker pods. The plan for later phases (checking that a test fails on the base version, possible bugs as findings, mutations) is in [design-mr-tests.md](design-mr-tests.md).

## Images

`MediaReviewer.review({ repo, mergeRequest, refs, files, usages, code, paths })` gets added or changed `png/jpg/gif/webp/svg` files (SVG text via `readFile`, raster bytes via the optional `forge.readFileBytes`, left out when the forge lacks it), the added lines that mention them, `code` — markup and component files (`.html/.jsx/.tsx/.vue/.svelte/.astro`) whose added lines contain `<svg`, `<path` or a `d=` attribute, with their head text and added line numbers (`inlineSvgFiles`) — and `paths`, every path the diff adds or changes. The step runs when there are images or such code files. Its comments become `minor` `performance` findings that count toward `maxComments`; its Markdown summary is appended under "Images". `noopMediaReviewer` is the default.

## REVIEW.md conventions

Put a `REVIEW.md` at the repository root; it goes first into the agent context. Write it for a reviewer: what matters in this codebase (money math, migrations, public API stability), what not to flag (style handled by tools, generated code), how tests are expected to look. A section headed `## Ignore` (or `## Skip`) lists path globs, one per bullet, added to the `ignore` option:

```md
## Ignore

- `src/generated/**`
- legacy/*.js
```

A section headed `## Paths` (or `## Path instructions`) gives rules for files matching a glob, one per bullet as ``- `glob`: rule``; indented lines continue the rule. Rules whose glob matches a file in scope go into the prompt with the matching files:

```md
## Paths

- `migrations/**`: every migration must be reversible.
- `src/api/**`: keep the public contract; bump the version
  on breaking changes.
```

## Data and report

`ReviewData`: MR, `head`, `previousHead`, `mode` (`full`, `incremental`, `reply`, `skipped`), `verdict`, `summary`, `walkthrough`, `effort`, `comments` (id, path, lines, severity, category, source, suggestion with the original text, posted/error, link), `threads` (resolved/replied/kept with reason and, for replies, the `learning`), `skipped` files, `stats` (files, changed lines, dropped findings by reason), `approved`, `checks`, `tests` (see [Tests](#tests)), `usage` (turns, cost, tokens).

Report sections: **Summary** (with effort and the walkthrough), **Findings** (table by severity, comments with tags `new`/`rejected`/`suggestion`, findings no longer reported compared with the previous review of the same MR), **Suggestions** (`changes` block with `applicable: false` — suggestions are applied in the forge), **Tests** (when the option was on: table of tests with verdicts and runs, passing tests as an applicable `changes` block, functions not tested), **Threads**, **Not reviewed**. Metrics: verdict, comments, major and critical, suggestions, threads resolved, files reviewed, passing tests (when tests ran), cost.

## Cost control

- `maxDiffLines` skips huge MRs before any agent call; ignored paths never reach the prompt.
- Incremental reviews only send new lines as in scope; nothing new means no agent call.
- Re-checks use the triage model and are capped at 10 threads per run.
- Guidelines are trimmed; guidelines, instructions and knowledge go into `context` so the provider can cache them across runs.
- Usage per run (`turns`, `costUsd`, tokens) is stored in the record and shown in the report.

## Limitations

- Duplicate detection is word overlap, not semantics.
- The summary note is submitted with the comments, so it cannot mention comments the forge rejected (the stored data does).
- Suggestions in replies use GitLab's markup.
- `## Ignore` and `## Paths` are read from the trimmed REVIEW.md (6 000 characters); keep them near the top of a long file.
- Threads re-checked as fixed are resolved without asking the author.
