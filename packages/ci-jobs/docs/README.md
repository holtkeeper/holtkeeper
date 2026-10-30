# @holtkeeper/ci-jobs

How long CI jobs take and how often they fail, per repository and over time. Job attempts are kept in the store (`CiJobStore`), so the first run reads the history once and every later run fetches only what is new. Produces serializable `CiJobsData` and a `ci-jobs` analysis kind that turns it into a universal `Report` with trends, slowdowns, weekly heatmaps and a jobs table with sparklines.

## Analyzer

`ciJobsAnalyzer` (`kind: 'ci-jobs'`, scope `repo`, `needs: { forge: true, history: true }`). A fresh install runs it every night through the default schedule `ci-jobs-nightly`. `createCiJobsAnalyzer({ now? })` builds one with another clock. Without `history.ciJobs` it reads the whole window into memory each run and says so in the notes.

| Option             | Flag               | Default | Meaning                                                    |
| ------------------ | ------------------ | ------- | ---------------------------------------------------------- |
| `days`             | `--days`           | `90`    | Window length, ending now                                  |
| `branch`           | `--branch`         | —       | Only pipelines of this branch or tag; every ref when unset |
| `recentDays`       | `--recent-days`    | `14`    | Trailing days compared with the rest of the window         |
| `changePercent`    | `--change-percent` | `20`    | Median change in percent that marks a job slower or faster |
| `minChangeSeconds` | `--min-change`     | `15`    | Smallest median change in seconds that counts              |
| `maxJobs`          | `--max-jobs`       | `50000` | Job attempts one sync reads at most                        |

Presets: `default-branch-quarter` (`main`, 90 days) and `half-year` (180 days, 28 recent days).

## Pipeline

1. **`syncCiJobs({ forge, store, repo, since, syncedFrom?, limit })`** — the first run, or one asking further back than any earlier full sync (`syncedFrom`, kept in the previous record's `history`), reads every job since `since`; later runs read from a day before the newest stored job, so jobs that were still running get their final status. Reads go through `listProjectJobRuns`; forges without it fall back to `listPipelineRuns` and `listJobRuns` per pipeline (newest 300). Only finished attempts (`success`, `failed`, `canceled`) are stored.
2. **`analyzeCiJobs(records, { from, to }, options)`** — pure; the computations below over the stored attempts of the window.
3. **`ciJobsAnalysis`** / **`ciJobsReport(data, { previous?, repo?, ref? })`** — the report. `ciJobsDataSchema` (zod) validates uploads.

## Computations

Durations are seconds, rates percentages, weeks start on Monday (UTC).

- **Attempts and finals**: the attempt with the highest job id per pipeline and job name is final; earlier ones were retried.
- **Durations** come from successful attempts: p25, median, p75, p95 and max per job and per job and week.
- **Failure rate** counts final attempts; jobs allowed to fail and canceled ones are left out. **Retried** is the share of pipelines where the job needed more than one attempt; **flaky** counts pipelines where an attempt failed and a later one passed.
- **Trend**: the median of the last `recentDays` against the median of the window before them. `slower`/`faster` needs at least five successful runs on each side and a change of `changePercent` and `minChangeSeconds`; `new` has no earlier runs, `idle` no recent ones, everything else is `stable`.
- **Change point** (slower and faster jobs): over daily medians, the day where the mean before and after differs most in the trend's direction, weighted towards balanced splits, with at least three days on each side. It names the first run of that day: time, commit, ref and link.
- **Pipeline time**: first job start to last job end of a pipeline, retries included; quartiles per week.
- **Pipelines by branch** (`refGroupOf`): each pipeline falls into one group — the default branch (from the forge, else `main`, `master` or `trunk`), development branches (`dev`, `develop`, `development`, `staging`, `stage`, `next`, `integration`), release and hotfix branches (`release…`, `hotfix…`, `rc…`, `support…`), merge requests (`refs/merge-requests/…`), tags (by the forge's `tag` flag, not by name) and every other branch as feature branches. Per group: pipelines, distinct refs, failure rate (pipelines with a failed job not allowed to fail), pipeline time of passing pipelines with its weekly median and p95, the recent median against the earlier one, and the five busiest refs. **CI time** sums the run time of every attempt, per job (with its share), stage and week. **Queue** is the median `queuedSeconds`.

## Data

```ts
interface CiJobsData {
  window: { from; to; days }
  options: CiJobsOptions
  defaultBranch?: string
  history: { oldest?; newest?; jobs; syncedFrom? }
  sync: { mode: 'full' | 'incremental' | 'none'; after?; fetched; stored }
  notes: string[]
  totals: {
    runs
    pipelines
    jobs
    failures
    failureRate?
    retryRate
    flakyJobs
    slowerJobs
    fasterJobs
    computeSeconds
    wallTime
    queue
  }
  weeks: {
    week
    pipelines
    runs
    failures
    failureRate?
    p25?
    median?
    p75?
    p95?
    queueMedian?
    computeSeconds
  }[]
  refGroups: {
    group: 'default' | 'develop' | 'release' | 'feature' | 'merge-request' | 'tag'
    label
    pipelines
    refs
    failureRate?
    duration
    recentMedian?
    baselineMedian?
    change?
    weeks
    topRefs
  }[]
  stages: { stage; computeSeconds }[]
  jobs: JobStats[] // by CI time, largest first; per job: duration spread, rates, trend, changePoint?, weeks, last run
}
```

## Report

`kind: 'ci-jobs'`, label `CI jobs`, listed on the web UI's **CI jobs** page. Metrics (with deltas against the previous record): default branch pipeline time median, pipeline time median, job failure rate, jobs slower, jobs faster, flaky jobs, CI time per week, queue median.

Sections:

1. **Slowdowns and speedups** — slower and faster jobs as issues ordered by CI time per week they add or save, naming when and on which commit the duration shifted; a weekly median chart with a p25–p75 band and a marker at the change for the three heaviest slowdowns.
2. **Pipelines** — pipeline time per week (median, p95, p25–p75 band), job runs with failure rate on a second axis, CI time with queue median, and CI time by stage.
3. **Pipelines by branch** — a table of the groups with a weekly median sparkline, p95, recent change and failure rate; a line per group of weekly median pipeline time; the busiest refs.
4. **Jobs** — every job by CI time (100 heaviest): runs, median with a weekly sparkline, p95, recent change, failure rate with a weekly sparkline, retried, flaky, CI time share.
5. **Week by week** — heatmaps of the 25 heaviest jobs: weekly median against the job's own median (diverging, ±50 %), and failure rate per week.
6. **Reliability** — jobs that failed or passed only on retry, worst failure rate first.
7. **Notes** — window, branch, stored history, what this run fetched, definitions and sync notes.

## Limitations

- Stored attempts are never pruned by the analyzer; `CiJobStore.prune` is there for retention.
- A full sync of a very busy repository stops after `maxJobs` attempts; the notes say from when history is incomplete.
- Pipeline time is measured from jobs, so jobs that never started (skipped, manual) do not count, and the forge's own pipeline duration may differ.
