# Design: tests for merge requests

Status: phase 1 is implemented (`@holtkeeper/review-tests`, the review's `tests` option); phases 2–4 are proposals.

## Goal

During a merge request review, write tests for the code the merge request changes, run them in Holtkeeper (not only inside the agent's own loop) and report what the run proves:

- the test passes on the merge request head;
- the test fails without the change, so it actually checks the new behavior;
- a test that fails on the head because the code, not the test, is wrong becomes a review finding.

The author gets a ready test file they can accept in one click.

## What already exists

| Need                                    | Existing piece                                                                      |
| --------------------------------------- | ----------------------------------------------------------------------------------- |
| Framework, layout, file naming, imports | `detectTestSetup`, `frameworkFor`, `testPathFor`, `testPathProblem` (quality-tests) |
| Command for one test file               | `singleTestCommand` (quality-tests)                                                 |
| Functions in a file and their ranges    | `findFunctions`, `isTypeOnlySource` (quality-tests)                                 |
| Prompt and answer shape for a test      | `examplePrompt`, `exampleTestSchema` (quality-tests)                                |
| Dependencies and workspace builds       | `installDependencies`, `buildWorkspaces` (coverage)                                 |
| Sandboxed command execution             | `CommandRunner` from `context.checkout` (exec-container: no network, read-only)     |
| Lines in scope, incremental reviews     | `scopeDiff`, `ReviewPlan` (review)                                                  |
| Acceptable file creation                | `CodeChange` with a `create` edit, `openMergeRequest` (changes)                     |
| Injected optional step                  | the `MediaReviewer` pattern (review)                                                |

What is missing is the step in the review, the independent run and the check against the base version.

## Shape

The review gets one new optional step, `tests`, built the same way as `media`: the contract lives in `@holtkeeper/review`, the implementation in a new package `@holtkeeper/review-tests` built on `quality-tests` and `coverage`. The review never imports `quality-tests` directly.

```ts
/** Writes and runs tests for the code a merge request changes. */
export interface MergeRequestTester {
  test(input: MergeRequestTestInput): Promise<MergeRequestTestOutcome>
}

export interface MergeRequestTestInput {
  dir: string // checkout at the head
  runner: CommandRunner
  agent: Agent
  scope: ReviewScope // files and added lines in scope
  baseSha: string
  headSha: string
  mr: { title: string; description?: string }
  previous?: readonly ReviewTest[] // tests of the previous review, for incremental runs
  options: ReviewTestOptions
  signal?: AbortSignal
}

export interface MergeRequestTestOutcome {
  tests: ReviewTest[]
  candidates: Candidate[] // findings: possible bugs, broken tests
  changes: CodeChange[] // one `create` per test that passed on the head
  summary?: string // Markdown for the summary note, under "Tests"
}
```

Phase 1 ships a smaller contract: `test(input)` returns the `ReviewTestRun` stored in `ReviewData.tests`; the review derives changes and the summary from it, and `candidates` come with phase 2.

`ReviewSteps` gets `tests(run, loaded, plan, usage)`. It runs after `agentReview`, so it can skip code the agent has already flagged as broken. Its candidates go through the same validate, dedupe and rank steps as all other findings.

## Flow

### 1. Targets

From the scope: functions (`findFunctions`) that overlap added lines in source files.

Skipped:

- test files, generated files, type-only sources;
- languages without a detected framework;
- functions with fewer than `minLines` added lines (default 3);
- targets whose test from the previous review is still valid. The key is path + symbol, and the test is reused while the function's text and the test file are unchanged.

Targets are ranked by added lines and branch count, and capped at `maxTests` (default 2). The whole step is skipped when the merge request changes only tests or docs.

### 2. Preparing the checkout

`installDependencies` and `buildWorkspaces` run once per review, through the job's sandboxed runner. If the install fails, the step is skipped with the reason `install-failed`, and the review carries on.

Before writing tests, the runner runs the existing test files of the target's folder once. If they already fail on the head, every result is ambiguous. The step then reports `baseline-red` and writes nothing.

### 3. Writing: a loop Holtkeeper controls

The agent (`taskKind: 'tests'`, capabilities `read` + `search`) answers with `exampleTestSchema`. The prompt is `examplePrompt`, extended with:

- the merge request title and description;
- the numbered diff of the target, so the agent knows which behavior is intended.

Holtkeeper writes the file itself and runs `singleTestCommand` with a timeout (default 120 s). On failure, the agent gets the last 80 lines of output and answers again: a fixed test, or the verdict `code-wrong` with a reason. At most `attempts` rounds (default 3).

The agent does not get `run`. Holtkeeper decides when to run and what counts as passing, so the agent cannot report "it works" without proof.

### 4. Independent run on the head

The final file is run `repeat` times (default 2). Results:

- passes every time: `passes`;
- passes sometimes: `flaky` (test dropped, reported);
- fails, with the agent saying `code-wrong`: goes to step 6.

### 5. Does the test check the change?

The target's source files are restored to `baseSha` (`git show <base>:<file>`), the test is run again, and the head versions are put back.

| Head | Base                                  | Verdict          | Meaning                                               |
| ---- | ------------------------------------- | ---------------- | ----------------------------------------------------- |
| pass | fail                                  | `catches-change` | The test checks the new behavior                      |
| pass | pass                                  | `guards`         | Behavior unchanged (refactor) or the test is too weak |
| pass | does not build (new file or function) | `new-code`       | Nothing to compare with; mutations decide (phase 3)   |

For `guards` on a merge request that is not a refactor (its type from the conventional title is not `refactor`), the summary says the test does not distinguish the change. The test is still offered as a regression guard.

### 6. Possible bugs

The agent says `code-wrong` when an expectation it derived from the merge request intent (title, description, names, doc comments) contradicts the code. The failing assertion becomes a `major` `correctness` candidate on the target line, with:

- the test name;
- the expected and actual values;
- the command and output tail.

The test file is attached to the summary, not offered as a change. A failure without such a verdict (a test the agent could not fix) is only counted as `unfinished`. It never becomes a comment.

### 7. Output

- **Changes.** `passes` tests become `CodeChange`s (`confidence: 'review'`, source `agent.name`) and are accepted through the existing `POST /api/analyses/:id/changes` as a patch or a separate merge request. Inline suggestions cannot create files, so the summary note lists each test as a collapsed block with the verdict and a link to accept it.
- **Comments.** Only possible bugs. `catches-change` and `guards` do not take inline comment slots (`maxComments`).
- **Data.** `ReviewData.tests: ReviewTest[]`:

  ```ts
  interface ReviewTest {
    id: string // stableId(path, symbol)
    target: { path: string; symbol: string; startLine: number; endLine: number }
    testFile: string
    framework: TestFramework
    command: string[]
    verdict: 'catches-change' | 'guards' | 'new-code' | 'possible-bug' | 'flaky' | 'unfinished'
    head: { passed: number; runs: number; durationMs: number }
    base?: { passed: boolean; buildFailed?: boolean }
    mutations?: { killed: number; total: number } // phase 3
    attempts: number
    changeId?: string
    output?: string // tail of the last failing run
  }
  ```

- **Report.** A **Tests** section: a table of targets, verdicts and run counts. Metrics: tests written, catching the change, possible bugs.

### 8. Cleanup

Every file the step wrote or restored is put back with `git checkout <head> -- <paths>` and `rm` of new paths. Only those paths: the checkout stays shared with the other steps. A `finally` block makes sure this runs.

## Options

New `review` analyzer options (as implemented):

| Option          | Default | Meaning                                                        |
| --------------- | ------- | -------------------------------------------------------------- |
| `tests`         | `false` | `true` turns the step on; also `/holtkeeper review tests=true` |
| `maxTests`      | 2       | targets per run                                                |
| `testRepeat`    | 2       | runs on the head                                               |
| `testTimeoutMs` | 120 000 | ms per run                                                     |
| `testAttempts`  | 3       | rounds of writing and running                                  |

Off by default: the step installs dependencies and runs project code, which costs minutes and tokens. It needs `exec-container` or isolated worker pods (see `docs/deployment.md`).

A separate command `/holtkeeper tests` runs only this step on the merge request and posts its own note. Teams can then turn it on for MRs without turning it on for every review.

## Phases

1. **Write and run.** Targets, preparation, the controlled loop, the independent run, changes, data, report. Tested with `createFakeRunner` and a fake agent; one integration test on a `fixtures/` project with `bun:test`.
2. **Against the base.** Step 5 and possible bugs (step 6).
3. **Mutations for new code.** ast-grep mutations of the added lines (negated conditions, `<` ↔ `<=`, a returned value replaced by a constant, a removed call). At most 5 per target, each followed by a test run. Reports `killed/total`. Also diff coverage of the merge request: added lines covered by existing tests, from `collectCoverage` limited to the related test files.
4. **Commit to the merge request branch.** `/holtkeeper tests commit` commits accepted tests to the source branch with `forge.commit`: same-repository MRs only, with explicit confirmation, never automatically.

## Open questions

- **Several functions in one file.** One test file per target, or one file per source file? Going by `testPathFor`, one per source file; then a target adds cases to an existing file, and the change is a `replace` instead of a `create`.
- **Go.** `singleTestCommand` runs the whole package. Run `-run '^TestName$'` with names from the answer, otherwise the existing package tests mix into the result.
- **Model routing.** `taskKind: 'tests'` gets its own `models.tests` entry in the agent setting, or uses the review model.
- **Cost limit.** A dollar limit per merge request (from `usage.costUsd`) after which the step stops.
