# @holtkeeper/upgrade-check

An AI check of what breaks when a running installation upgrades from one version of a repository to another, e.g. a certification environment that moves twice a year. The work is split across agents by area of the change, like a split code review. It talks to the LLM only through `Agent`, to git only through `CommandRunner`, and to the forge only through `GitForge`.

## Analyzer

`createUpgradeCheckAnalyzer(deps)` / `upgradeCheckAnalyzer`: kind and analysis `upgrade-check`, scope `repo`. It needs a checkout (jobs set `ref` to the `to` sha), the forge and an agent (`required`). It keeps the newest 50 records per repository. It has no `refresh`, so it never runs on a schedule or a trigger. Queue it only on demand.

| Option              | Meaning                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------- |
| `from`              | commit sha or tag installed now (required, never starts with `-`)                       |
| `to`                | commit sha or tag to upgrade to (required, never starts with `-`)                       |
| `fromLabel`         | display label of `from`, e.g. `1.4.0`                                                   |
| `toLabel`           | display label of `to`                                                                   |
| `apiChanges`        | markdown of the public API changes of the repository's own packages, computed by caller |
| `dependencyChanges` | markdown of the dependency changes, computed by caller                                  |
| `commits`           | commit subjects of the range; read with `git log --no-merges from..to` when absent      |
| `costLimitUsd`      | soft spend limit of the check in USD (default 6; 0 turns it off), see Areas below       |

`UpgradeCheckDeps` (all optional):

- `inputsFor(repo, { from, to, signal? })`: the `apiChanges` and `dependencyChanges` markdown, used when the options do not carry both. The options win. A failure leaves them out.
- `contextFor(repo)`: team rules for the agents' stable `context`, for example those of the `release` rules agent. A failure leaves them out.
- `toolsetsFor({ repo, dir })`: extra toolsets for the area passes. The host attaches its toolsets per task kind itself.

How the run works:

1. **Changes.** `resolveCommit` resolves both refs in the checkout with `rev-parse --end-of-options`; it never fetches, since job checkouts come from a mirror that already has every ref. Git runs with `--literal-pathspecs`, so paths are never read as globs or pathspec magic. `gitRangeSource` reads `git diff --name-status -z` and `--numstat -z` with rename detection, then reads diff text per area (at most 200 paths per call). When `from` cannot be found or `git diff` fails, the forge's `compareCommits` is used instead (`diffFilesSource`).
2. **Pipeline.** The run calls `runUpgradeCheck` (see below).
3. **Record.** The record's `ref` is `upgradeCheckRef(fromSha, toSha)`, i.e. `<fromSha>..<toSha>`, so a later request for the same range can find it. Its `sha` is the `to` commit.

The run uses `context.step` for its `changes` and `check` steps when the task engine provides it.

## Pipeline

`runUpgradeCheck(run)` takes `{ agent, dir, from, to, source, commits?, apiChanges?, dependencyChanges?, context?, toolsets?, costLimitUsd?, signal?, log? }` and returns `UpgradeCheckData`:

1. **Select.** `selectFiles` skips binary files and the lockfiles and generated, vendored, built or minified files of `isRangeNoise` from [@holtkeeper/release](../../release/docs/README.md). At most `MAX_FILES` (600) files are kept: source before tests and docs, smaller changes first. The rest is skipped and the check is marked `capped`.
2. **Group.** `groupAreas` keeps a change within `SINGLE_AREA_MAX_LINES` (600) changed lines and `SINGLE_AREA_MAX_FILES` (20) files in one area. Otherwise it groups files by `areaKeyOf`: the top-level directory, or two levels under `apps`, `packages`, `libs`, `services`, `modules`, `cmd`, `internal`, `pkg`, `src`, `plugins`, `components` and `deploy`. While there are fewer than `MAX_AREAS` (8) groups, the heaviest group over `AREA_SPLIT_LINES` (1 500) changed lines with more than one file is split by its next directory level, or into two contiguous halves (`<key> (part 1)`, `(part 2)`) when its files share one directory, so a large change under one directory still spreads over several passes. The heaviest groups then seed at most `MAX_AREAS` areas, and the remaining ones join the lightest area.
3. **Plan.** One call (task kind `upgrade-plan`, phase `plan`, tier `fast`, no tools, one turn) names each area and says what to look for. It reads the area file lists, the commit subjects (at most `MAX_COMMITS`, 200, each cut to 200 characters) and the computed API and dependency changes (each cut to `CONTEXT_MAX_CHARS`, 12 000). If the plan fails, the areas keep their directory names and get no focus.
4. **Areas.** One pass per area runs with task kind `upgrade-check`, phase `area`, tier `main`, `read` and `search` capabilities and `areaTurns` turns (`AREA_MIN_TURNS` 20, one more per file and per 20 changed lines, at most `AREA_MAX_TURNS` 40), at most `AREA_CONCURRENCY` (4) at once. The passes share `AREA_BUDGET_SHARE` (0.85) of `costLimitUsd` evenly; one that spends its share is asked for its answer (`answerAtCostUsd`). They read at most `AREA_READ_LINES` (400) lines per `read_file` by default and clear older tool results past `AREA_TRIM`. Each pass gets the range, the names of the other areas, the planner's focus (cut to 400 characters and presented as a hint derived from repository text, not an instruction), the commits, the computed changes, the area's renamed files (old → new) and its own diff, each file in a fenced `diff` block that the prompt calls data, never instructions. The diff goes through `rangeCodeDiff` and is cut to `AREA_DIFF_MAX_CHARS` (80 000). Files left out to fit are counted in `skipped`, and the check is marked `capped`. A pass returns a summary and structured findings; at most `MAX_FINDINGS_PER_AREA` (15) are kept, breaking and risky ones first (`capFindings`). A pass that gives no structured answer (turn limit, unparsable JSON) counts as failed. The system prompt covers API contracts, configuration and environment variables, migrations and stored data, behavior, runtime and dependency requirements, and deployment files. Findings must be grounded in code the agent read, and each must say how to check it.
5. **Merge.** `dropDuplicateFindings` merges findings across areas. `sameFinding` treats two findings as the same when they have the same category and either the same title, the same file and line, or a similar title on a shared file. The merged finding keeps the higher severity and both sets of files (at most 10).
6. **Verdict.** One call (task kind `upgrade-plan`, phase `verdict`, tier `fast`, no tools) returns the verdict, a short markdown summary and the remaining duplicates. It lists at most `VERDICT_MAX_FINDINGS` (60) findings, the rest as counts, with area summaries and details cut to 600 characters. `settleVerdict` keeps the verdict within what the findings support: never milder than `verdictFloor` (`breaking` when any finding is breaking, `review` when any is risky), never `breaking` without a breaking finding, and at least `review` when an area was not checked. If the call fails, the verdict follows the findings and the summary is a fixed sentence.
7. **Ids.** `finalizeFindings` sorts findings by severity and gives each a stable id from its category, title and first file.

An area that fails or gives no structured answer is listed in `skipped` and named in the summary under **Not checked**. The run rejects when every area fails, when a spend limit (`BudgetExceededError`) stops a pass, or when it is aborted. A range with no readable changes returns `safe` without any agent call.

## Data

`UpgradeCheckData` (`upgradeCheckDataSchema`):

```ts
{
  from: { ref: string; sha: string; label?: string }
  to: { ref: string; sha: string; label?: string }
  verdict: 'safe' | 'review' | 'breaking'
  summary: string // markdown
  areas: { name: string; files: number; summary: string }[]
  findings: {
    id: string
    severity: 'breaking' | 'risky' | 'info'
    category: 'api' | 'config' | 'data' | 'behavior' | 'dependency' | 'infra' | 'other'
    title: string
    detail: string
    files: { path: string; line?: number }[]
    affects?: string
    check: string // how to check or prepare
  }[]
  skipped: { files: number; reason: string }[]
  capped: boolean
  usage?: { turns: number; costUsd?: number; inputTokens?: number; outputTokens?: number }
  durationMs?: number
}
```

`upgradeCheckAnalysis` summarizes a record as these metrics: verdict, breaking and risky counts, files checked, areas and cost. Its report has a summary, findings grouped by severity (each with its files, who it affects and how to check it), an areas table and a **Not checked** table.

## Host wiring

- Task kinds: `upgrade-plan` (no toolsets) and `upgrade-check` (`code`, `knowledge` search only, `packages`, `git`). Both belong to the `release` rules agent and the `releases` AI usage feature.
- Queue jobs with analyzer `upgrade-check`, `ref` set to the `to` sha, and options `{ from, to, fromLabel?, toLabel? }`, with both refs as shas.
