# @holtkeeper/rule-miner

The `rule-miner` analyzer: learns short rules from what reviewers keep asking for. It reads the review threads of merged merge requests, keeps the comments that led to a change, asks a model once for short imperative rules backed by those comments and stores them as **learnings** (`Learning` in [@holtkeeper/store](../../store/docs/README.md), lifecycle in [@holtkeeper/rules](../../rules/docs/README.md#learning-lifecycle)). Every learning links to the notes that taught it. It follows the rule-miner pattern of AI review tools: comments that changed code, weighted by recurrence, capped output, near-duplicates merged instead of repeated.

```ts
import { createRuleMinerAnalyzer } from '@holtkeeper/rule-miner'

createRuleMinerAnalyzer({ store, botUsername, policy, now })
```

## API

- `createRuleMinerAnalyzer(deps?: RuleMinerDeps)`: the analyzer, kind `rule-miner`, analysis `ruleMinerAnalysis` (label **Rule miner**). Without `deps` (catalogs) it applies everywhere but `run` throws.
- `RuleMinerDeps`: `store` (`learnings`, `kv`, optional `audit`), `botUsername(repo)` (Holtkeeper's own forge account, whose notes and merge requests are ignored), `policy(repo)` (approval delay and expiry, default `DEFAULT_LEARNING_POLICY`), `now`.
- `RuleMinerData`: the analysis record — `outcome` (`mined` or `skipped` with `reason`), `firstRun`, `window` (since, until, merge requests, discussions, reviewer threads, comments kept), `rules` (each with `outcome` `created`, `duplicate`, `skipped` or `dropped`, the learning id, `files`, supporting comments and merge requests, sources a duplicate added, and why), `call` (tier, model, cost, estimate), `version` (`MINER_VERSION`) and the one-off `prompt`.
- `minerMarker(repo)` / `readMinerMark`: the `Store.kv` key `rule-miner:<forge>:<path>` holding `MinerMark` `{ at, jobId?, minedUntil?, runs, created }`.
- `collectReviewComments`, `linesTouched`, `noteUrl`, `isBot`, `isDependencyUpdate`: evidence collection; `mineRules`, `acceptRules`, `estimateMinerCost`, `CALL_CAPS`: the call; `minerPrompt`, `minerOutput`, `MINER_SYSTEM`: the prompt; `sourceFolderGlob`: the folder scope.

## When it runs

- **Every 14 days at most** (`MINE_INTERVAL_DAYS`). It declares `refresh: { on: 'change', minInterval: '14d' }`, and `appliesTo` is false while the repository's mark is younger than that; `run` checks again for manual runs. `force: true` runs anyway.
- **At most `DAILY_RUNS` (10) automatic runs a day** (`dailyLimit`), so queuing a whole fleet spreads its cost.
- Default branch only (a `ref` is refused), keeps the newest 10 records. Needs a checkout (the agent runs in it without tools), uses the forge and the agent when present: without either the run is skipped and leaves no mark.

## Evidence

`collectReviewComments` lists merge requests merged since the window start (the first run reads `months` back, default 6; later runs read from the last run's `minedUntil`), at most `maxMergeRequests` (80), without bot authors and dependency updates, and reads the discussions of the newest `discussionMergeRequests` (40). A thread counts when its first note is a person's other than the merge request author, and it led to a change:

| Signal         | When                                                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `changed`      | a line comment whose lines (±2) the diff from the commented commit to the merge request's final head touches (`compareCommits`, at most 60 comparisons) |
| `acknowledged` | the merge request author replied "done", "fixed", "addressed", ... and the lines are not known to be unchanged                                          |
| `resolved`     | the thread is resolved and the lines are not known to be unchanged                                                                                      |

A resolved thread whose commented lines stayed the same was dismissed and is dropped. Comments come best signal first, newest merge request first, people named by role (`author`, `reviewer 1`, ...), notes cut at 500 characters, threads at 1 200, all comments at 24 000. Each keeps its source: repository, merge request, discussion id, note id, author, time and link (`#note_<id>` on GitLab, `#discussion_r<id>` on GitHub).

A run with fewer than `minComments` (3) comments calls no model: the mark's `at` moves (so the interval applies) but its window does not.

## The call

`mineRules` makes one agent call with no tools, at most two turns, `context: MINER_CONTEXT` (so the server adds no rules block), `taskKind: 'rule-miner'`, the tier's cap (`CALL_CAPS`: `main` $0.40, `deep` $1.00) and an estimate (`estimateMinerCost`) for the weekly budget check. A `BudgetExceededError` propagates: nothing is stored and the mark stays. The prompt lists the comments as `[c1] !12 (lines changed after the comment)` items and the active and pending learnings that already name the repository, and asks for at most the run's cap of one-sentence rules citing their comments.

`acceptRules` checks the answer: unknown comment ids are ignored and a rule left with none is dropped, so is a rule that contains a commenter's username; rules with the same normalized text are merged. The rest is ordered by recurrence — distinct merge requests, then comments.

## Storing

Best supported first:

- A rule that repeats an existing learning (`findDuplicateLearning`: same normalized text or word overlap ≥ 0.8, rejected learnings included) creates nothing. Its comments are merged into that learning as sources (`reinforceLearning`, which also brings an expired one back), and a learning scoped only to other repositories gets this repository added to its `repos`. Audited as `learning.reinforce`.
- Otherwise a learning is created through `newLearning` with the repository's policy: `origin: 'miner'`, `pending` until the approval delay passes (never approved by the miner), `scope: { repos: ['<forge>:<path>'] }`, `files: ['<folder>/**']` when every supporting comment is a line comment under one folder, every comment as a source, `model` and the call's cost split over the new learnings as `costUsd`. Audited as `learning.create` (actor `agent:rule-miner`).
- New learnings are capped: `FIRST_RUN_LEARNINGS` (10) on a repository's first run, `RUN_LEARNINGS` (5) later, and never more than `maxLearnings`. Duplicates do not count; rules over the cap are recorded as `skipped`.

Afterwards the mark records the run (`runs`, `created`, `minedUntil`).

## Options

| Option                    | Default | Meaning                                                          |
| ------------------------- | ------- | ---------------------------------------------------------------- |
| `months`                  | 6       | How far back the first run reads                                 |
| `maxLearnings`            | 10      | Most new learnings per run, below the first-run and per-run caps |
| `maxMergeRequests`        | 80      | Merged merge requests listed                                     |
| `discussionMergeRequests` | 40      | Merge requests whose threads are read                            |
| `minComments`             | 3       | Comments that led to a change needed before calling a model      |
| `tier`                    | `main`  | Model tier                                                       |
| `force`                   | false   | Ignore the 14-day interval and `minComments`                     |
| `prompt`                  | —       | One-off extra request, stored with the record                    |
