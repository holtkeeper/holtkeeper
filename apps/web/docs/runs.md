# Runs

Part of the web app's [Ops](README.md#runs) docs.

## Runs

**Runs** (`/ops/runs`, `features/jobs`, Ops workspace, shown with `analyses:read`) lists background analyzer runs (jobs) newest first, with the queue at a glance above them and recurring failures below. The search params are parsed by `parseJobsSearch` in `lib/jobs.ts` (`view`, `status`, `analyzer`, `repo`, `trigger`, `schedule`, `signature`, `q`); `/ops/runs/$jobId` shows one run on its own page.

### Header

- **Configure** (ghost, global `settings:read`) opens Settings › Analyzers, with the filtered analyzer's sheet open (`?item=<kind>`) when the Analyzer filter is set; the ⋯ menu has **Copy link** and, with a schedule filter, **Show on Automation**; **Run analyzer** (`analyses:run`) opens the run dialog (`useRunJob`).
- The `ScopeSwitch` narrows everything on the page to the repositories and groups of the viewer's home groups (_My teams_, `jobScopeRepos`) or leaves it at everything the viewer may read; a chosen repository wins over the scope.
- **Segments** (`runsSegment`, `?view=`): **All**, **Failures** (failed runs; the count is `queue.failed` of the stats window) and **Queue** (queued runs; the count is `queue.queued`). Failures and Queue fix the status, so switching segments drops the status filter (`runsSegmentWith`); `runsFilter` turns the params into the list filters.
- **Filter pills** are single-choice `FilterButton`s: Status (All only), Analyzer, Repository and Trigger. A schedule (`?schedule=`, from Automation) and a failure signature (`?signature=`, from a recurring failure or a run) show as removable chips.
- The search field (`/` focuses it, `?q=`) is sent to the server after 300 ms (`runsFilter` passes `q` to `GET /api/jobs` and `GET /api/jobs/count`), which matches id prefix, repository or group, and analyzer kind or label over every run the viewer may read, not only the loaded pages; the footer total counts the matches.

### Queue health

From `GET /api/jobs/stats` over the same scope (`useJobStats`, every 10 seconds), shown once it loads:

- A `Strip` (`queueFigures`): workers busy of live workers (only when the stats list workers), queued, running with what their agent runs spent so far, claim delay p50 and p95, failed and blocked by budget in the stats window.
- **Workers**, only when the stats return `workers` (viewers with `analyses:read` over everything): each live worker's id, busy with how many runs or idle (`workerStateText`), and the newest heartbeat. An empty list says no worker announced itself recently.
- **Why queued**: the wait buckets of the oldest queued runs, largest first (`waitBuckets`, `waitKindText`), with how many were sampled when not all, and **Open Queue view** outside the Queue segment.

### Table

Columns: Status, Analyzer with a line under it, Repository · ref, Trigger (schedule name in mono, the requesting person's avatar and name, or the trigger with its icon), Duration, Tries (`attempts/maxAttempts`, amber after a retry), Cost and Started. The line under each run comes from `runSubline`: the batched `JobList.waitHints` entry of a queued run (`waitHintText`: its first reason with how many more, or the free worker slot with the runs ahead), "Stopped by the AI budget" for a blocked run, the failure signature (or the error's first line) of a failed run, and the last failed attempt of a running or finished run that was retried. Cost is `JobList.costs` (`runCostText`, `—` without agent runs). Started reads "waiting 2 min 10 s" or "due in 5 minutes" for a queued run (`runStartedText`). The footer counts the shown runs, loads older pages and hints J/K.

### Recurring failures

Under the table in All and Failures: `GET /api/jobs/failures` over the scope and the chosen analyzer, grouped by analyzer and error signature for 24 h, 7 d or 30 d (`RecurringFailures`). A row switches to Failures filtered to that analyzer and signature; the id opens the latest run with it; **All failures** switches to the Failures segment.

### Run sheet

A row opens `RunSheet` (J/K step through the shown rows, **Open as page**, the steps of the latest attempt as the progress bar, **Cancel run** or **Run again** and **Open result** in the ⋯ menu). Tabs:

1. **Steps**: the status, target, ref and attempt; why it ran from `GET /api/jobs/:id/why` (origin, outcome, wait reasons) with **Show on Automation** and **Runs with the same failure**; the error; the attempt strip (one segment per attempt with its status) and the picked attempt's step timeline and log tail; then the run facts: trigger, requester, worker with the execution `mode` from `JobWhy`, attempts, created, started with the claim delay (`claimDelay`), finished, duration, cost against `JobWhy.costCapUsd` (`costCapText`) and the options (`optionsSummary`, **Show** for the JSON).
2. **Logs**: the picked attempt's log, following live lines while it runs.
3. **Findings**: the stored result's title and headline metrics, with **Open result**.
4. **Cost**: what the agent runs cost, a bar of the cap spent when the run carries one (`costCapShare`), and each agent run with its transcript (`JobAgentRuns`).

The run page (`JobPage`) shows the same sections one after another. While it loads or when the run cannot be read it keeps the header with the Ops › Runs › short id crumbs; a 403 shows the Forbidden card naming the missing permission.
