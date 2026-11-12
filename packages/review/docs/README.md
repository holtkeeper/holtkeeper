# @holtkeeper/review

AI code review of merge requests: the `review` analyzer reviews one merge request, posts inline comments (with one-click suggestions) and a summary, resolves its own threads once fixed, and answers replies in its threads. It talks to the forge only through `GitForge` and to the LLM only through `Agent`.

## Flow

`reviewMergeRequest(run)` runs replaceable steps (`ReviewSteps`, override any of them with `run.steps`):

1. **load** — `getMergeRequest`, `getMergeRequestDiff`, `listDiscussions`, and the previous review from history: the newest `review` record with `ref` `!<iid>` that reviewed something.
2. **plan** — reads the repository guidelines (and the path rules from REVIEW.md), decides the mode and scopes the diff: added lines of reviewable files, minus `ignore` globs (plus globs from REVIEW.md, see below). Deleted, binary and forge-collapsed files are skipped. Incremental: `compareCommits(lastHead, head)` intersected with the MR diff; only lines both add are in scope.
3. **deterministic** — with `includeChecks` (by default `testids`, which skips itself in repositories without test attributes), runs the injected checks (`secrets`, `testids`; `checksFor(repo)` builds them per repository, e.g. with the team's test id overrides) on the checkout and keeps issues touching lines in scope. A fix whose edits lie entirely on changed lines becomes the comment's suggestion. Findings of `agentCompletedChecks` (`testids`: interactive elements added without a test attribute) go to the agent instead when there is one: the prompt lists them with the project's convention, the agent comments on the ones it agrees with and suggests the attribute in the project's style, and the rest are dropped. Without an agent they are posted as found.
4. **agentReview** — one structured agent task (`taskKind: 'review'`, model tier `main`, or `deep` with `depth: 'deep'`): the system prompt holds the rules; `context` holds the repository's [Guide](../../guide/docs/README.md) from the `guideFor` hook: REVIEW.md, CLAUDE.md, AGENTS.md, CONTRIBUTING.md (read here, trimmed: 6 000 characters per file, 12 000 in all) first, then panel team rules, learnings, policies, generated text and knowledge notes ranked by the MR title and files (without the hook, just the rules files), then `options.instructions`; the prompt holds the MR title and description, the REVIEW.md path rules matching files in scope, open threads and the numbered diff per file (`+` in scope, `~` reviewed before, `-` removed). The agent reads more code with its tools instead of getting whole files. The checkout is never installed, so the system prompt sends dependency questions to the package tools: the organization's own packages through the API catalog (`search_symbols` by export name, then `get_symbol` or `get_package_api`), third-party ones through the library tools. Besides comments it returns a summary, a verdict, a `walkthrough` (logical changes with their files) and `effort` (1–5, how hard the change is for a human to review).
   - The system prompt asks for a deliberate pass: every changed file, the code around each change, its callers and the code paths it touches read with the tools (more for larger diffs); error paths, retries and idempotency, edge cases, concurrency and the contract with callers checked; every distinct problem reported up to `maxComments` instead of stopping at the first.
   - A pass over more than `INVESTIGATE_MIN_FILES` (3) files or `INVESTIGATE_MIN_LINES` (80) changed lines sets `followUpWithoutTools`: an answer given without opening any code is followed up once, asking the agent to inspect the changed code and return the complete JSON again (all findings, not only new ones). The extra turn counts in `usage` like any other.
   - A diff over `SPLIT_MAX_LINES` (600) changed lines or `SPLIT_MAX_FILES` (12) files is split by `splitReviewFiles`: files of one directory stay together (a directory over a limit is cut in path order, a file over the line limit is a part of its own), parts hold at most 12 files and are balanced by changed lines. Each part runs its own pass (`SPLIT_CONCURRENCY`, 3 at once, each with the full turn limit and the usual budget) with the MR title and description, the list of every file in scope, and only its own numbered diff, open threads, path rules and check requests. Candidates are concatenated (the usual dedupe and `maxComments` cap apply), summaries joined, walkthroughs concatenated, `effort` is the highest and the verdict the worst. A part that fails does not lose the others: the summary lists its files as not reviewed and the verdict becomes `needs-changes` (so `approve: 'when-clean'` never approves a partly reviewed MR); the review fails only when every part fails, a spend limit (`BudgetExceededError`) stops a part, or the job is aborted. Smaller diffs keep one pass.
5. **media** — images the diff adds or changes go to the injected `MediaReviewer` (see below).
6. **validate and rank** — every comment must target a new-side line shown by the diff; a line outside it moves to the nearest changed line (at most 5 away) or is dropped; in incremental reviews lines reviewed before are dropped. Suggestions must cover exactly `startLine..line`: copies of neighbouring lines are trimmed, no-op suggestions dropped, broken ranges lose the suggestion. Findings repeating an open thread (same path, line within ±2, similar text) or a deterministic finding are dropped. The rest is filtered by `minSeverity`, sorted by severity and capped at `maxComments`.
7. **recheck** — our open threads whose file changed since the last review (all of them after a force push) are re-checked on the `fast` model tier (`taskKind: 'triage'`, at most 10 per run). Fixed ones are resolved with a short note, threads whose file left the diff are resolved too. A thread that is still relevant and that the agent raised again gets a "still applies" reply instead of a duplicate comment.
8. **post** — one `submitReview` with the comments and the summary note (verdict, agent summary, review effort, the walkthrough in a collapsed table, findings per severity, thread outcome, what was not reviewed), `event: 'approve'` when `approve: 'when-clean'` and the review is clean (verdict `looks-good`, no major/critical finding, no thread still open). Incremental runs without anything new post nothing. Rejected comments are marked in the data.
9. **resolve summaries** — on forges where the summary is a resolvable thread (GitLab) and that have `resolveDiscussion`, the run lists the discussions again and resolves every unresolved summary thread of Holtkeeper's own account: its first note is a summary note (`isSummaryNote`: the `### Holtkeeper review:` heading and the summary marker) outside the diff, and its author is the token's account (`getCurrentUser`, else `botUsername`; with neither nothing is resolved), so a human's copy of a summary is never touched. With `resolveSummary: 'when-clean'` (default) this happens only when the verdict is `looks-good`, so `needs-changes` summaries stay open until a later clean run resolves them together with its own; `always` resolves after every run that reached the post step, `never` leaves them. Summary threads are never finding threads (`openThreads` keeps positioned discussions only), so dedupe and re-checks ignore them. A failing lookup or resolve (e.g. comments switched off) is logged and never fails the review; forges without `resolveDiscussion` are skipped.

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
| `includeChecks`   | `['testids']`                            | `true`, `false` or a list of `secrets`, `testids` (or `secrets,testids`); `testids` skips itself when the catalog is empty           |
| `approve`         | `never`                                  | `when-clean` approves clean reviews                                                                                                  |
| `resolveSummary`  | `when-clean`                             | `when-clean` resolves our summary threads after a `looks-good` run, `always` after every run, `never` leaves them open               |
| `depth`           | `standard`                               | `deep` reviews on the `deep` model tier (Opus) instead of `main` (Sonnet)                                                            |
| `ignore`          | lockfiles, generated, snapshots, dist, … | path globs (`DEFAULT_IGNORE`); globs without `/` also match base names                                                               |
| `maxDiffLines`    | 3000                                     | skip bigger diffs (added + removed lines in scope)                                                                                   |
| `language`        | the MR description's language            | language of comments                                                                                                                 |
| `instructions`    | —                                        | extra rules for this run, appended after the Guide                                                                                   |
| `media`           | `true`                                   | review images with the `MediaReviewer`                                                                                               |
| `replyTo`         | —                                        | discussion id: answer that thread instead of reviewing                                                                               |
| `releaseBranches` | `DEFAULT_RELEASE_BRANCHES`               | `source:target` branch globs of merge requests not reviewed (`develop:main`, `release/*:main`, `main:develop`, …); `[]` reviews them |
| `reviewOwn`       | `false`                                  | review merge requests authored by `botUsername`                                                                                      |
| `force`           | `false`                                  | review even what `releaseBranches` and `reviewOwn` skip (`/holtkeeper review force=true`)                                            |

**Not reviewed by default.** Before any checkout, a merge request between `releaseBranches` (release candidates like `develop → main`, back-merges like `main → develop`: their code was reviewed on the way into the integration branch) or authored by `botUsername` (Holtkeeper's own update, propagation and test merge requests; compared case-insensitively, so it needs the forge's bot username set in the panel) is stored as `mode: 'skipped'` with the reason and nothing is posted. `force` overrides both; thread replies (`replyTo`) are never skipped. Set the options per repository or group through the `analyzers.review` setting.

**What the job should set:** `ref` = the MR head sha (the webhook does). The engine's mirror fetches every ref, so the head of fork MRs (`refs/merge-requests/<iid>/head`) resolves too. When the checkout is not at the head, the analyzer checks out the head itself through `context.checkout`.

`ReviewAnalyzerDeps`: `checks` (`QualityCheck`s by name), `checksFor(repo)` (the checks for one repository; wins over `checks`, which it falls back to on failure), `testsExpected(repo)` (the server reads `repo.tests`; for a repository with no tests by design the run gets `ReviewRun.tests: false`: the system prompt drops "missing tests" from the minor severity and "callers and tests", and the `tests` category unless check requests of that category exist (then it is listed with a note that it is only for the flagged lines), and agent findings of category `tests` are dropped unless they complete a requested check finding, so the `testids` check is unchanged), `guideFor(repo, { docs, query })` (the resolved Guide for a review or thread reply, given the rules files read from the checkout and the text notes are ranked by; a `ReviewGuide` `{ text, scopes }` whose Guide scope keys — `all`, `group:<name>`, `family:<id>`, `repo:<forge>:<path>`, broad to narrow — are stored as `guideScopes`; the server passes `createGuideResolver` of `@holtkeeper/guide` and the scopes whose rules reached the text), `knowledge: { access, groupsOf? }` (the `knowledge` toolset is mounted and thread replies propose what authors teach), `toolsetsFor` (review-specific tool sets; the host attaches the shared code tools), `mediaReviewer`, `botUsername` (a string, or a function of the repository since each forge has its own), `steps`.

The record is stored with `ref` `!<iid>`.

## Conversations

`replyToThread({ forge, repo, mr, discussion, agent, dir?, botUsername?, language?, context? })` answers the latest reply in a thread we started, on the `main` model tier: `explain`, `concede` (and resolve) or `update` with a new suggestion (GitLab ` ```suggestion:-N+0 ` markup). Threads not started by us, and threads whose last note is ours, are skipped. With `options.replyTo` the analyzer runs it with the Guide as `context` and stores a `reply` record.

Lasting rules taught in replies are not extracted here: the server looks at each reply separately with a cheap filter and a fast-tier call ([review learnings](../../guide/docs/README.md#review-learnings)). `commentFinding(body)` reads the category and finding id back from an inline comment `commentBody` wrote, so reactions on it can be counted per category.

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

`ReviewData`: MR, `head`, `previousHead`, `mode` (`full`, `incremental`, `reply`, `skipped`), `verdict`, `summary`, `walkthrough`, `effort`, `comments` (id, path, lines, severity, category, source, suggestion with the original text, posted/error, link), `threads` (resolved/replied/kept with reason), `skipped` files, `stats` (files, changed lines, dropped findings by reason), `approved`, `checks`, `usage` (turns, cost, tokens and `model`, the provider id of the first agent run that named one — the main review run), `guideScopes` (Guide scopes whose rules reached the agent, broad to narrow; absent when the Guide named none) and `durationMs` (wall time of the run, posting included; skipped runs have none). The last three are optional, so records stored before them still parse. The MR link and comment links must be http(s) URLs; the schema rejects anything else.

Report sections: **Summary** (with effort and the walkthrough), **Findings** (table by severity, comments with tags `new`/`rejected`/`suggestion`, findings no longer reported compared with the previous review of the same MR), **Suggestions** (`changes` block with `applicable: false` — suggestions are applied in the forge), **Threads**, **Not reviewed**. Metrics: verdict, comments, major and critical, suggestions, threads resolved, files reviewed, cost.

`reviewMetrics(data)` is the kind's `metrics`, stored with every record as `ReviewMetrics`: `mergeRequest` (its id), `verdict`, `mode`, posted `comments` and their counts per severity (`severities`, every severity present), `suggestions`, findings the forge `rejected`, discussions `resolved`, `approved`, `costUsd`, and the merge request's `title`, `url` and `author`, `model`, `durationMs` and `guideScopes` so a fleet table needs no record data. `reviewMetricsSchema` parses stored metrics; fields newer than a record are absent. The server's Quality › Reviews (`GET /api/reviews`) lists rows from these metrics only.

## Cost control

- `maxDiffLines` skips huge MRs before any agent call; ignored paths never reach the prompt.
- Incremental reviews only send new lines as in scope; nothing new means no agent call.
- Large diffs cost one pass per part (see **agentReview**), and a shallow answer on a non-trivial diff costs one follow-up request.
- Re-checks run on the `fast` model tier and are capped at 10 threads per run.
- The Guide is capped (12 000 characters, deterministic text) and goes into `context` so the provider can cache it across runs.
- Usage per run (`turns`, `costUsd`, tokens) is stored in the record and shown in the report.

## Limitations

- Duplicate detection is word overlap, not semantics.
- The summary note is submitted with the comments, so it cannot mention comments the forge rejected (the stored data does).
- Suggestions in replies use GitLab's markup.
- `## Ignore` and `## Paths` are read from the trimmed REVIEW.md (6 000 characters); keep them near the top of a long file.
- Threads re-checked as fixed are resolved without asking the author.
