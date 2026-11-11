# @holtkeeper/ci-jobs

How long a repository's pipelines take, how often they pass and which jobs cause trouble. Job attempts are kept in the store (`CiJobStore`), so the first run reads the history once and every later run fetches only what is new. Produces serializable `CiJobsData`, the problem list behind the web UI's **CI** page and a `ci-jobs` analysis kind with the same content as a universal `Report`.

## Analyzer

`ciJobsAnalyzer` (`kind: 'ci-jobs'`, scope `repo`, `needs: { forge: true, history: true }`, `keepRecords: 3`). Freshness reruns it daily (`refresh: { on: 'time', cadence: '1d' }`) and records the default-branch head it read as the record's `sha`. Runners keep its newest three records per repository; the job history lives in `CiJobStore`, not in records. `createCiJobsAnalyzer({ now? })` builds one with another clock. Without `history.ciJobs` it reads the whole window into memory each run and says so in the job log, where sync notes go too.

| Option             | Default | Meaning                                                    |
| ------------------ | ------- | ---------------------------------------------------------- |
| `days`             | `90`    | Window length, ending now                                  |
| `branch`           | —       | Only pipelines of this branch or tag; every ref when unset |
| `recentDays`       | `14`    | Trailing days compared with the rest of the window         |
| `changePercent`    | `20`    | Median change in percent that marks a job slower or faster |
| `minChangeSeconds` | `15`    | Smallest median change in seconds that counts              |
| `maxJobs`          | `50000` | Job attempts one sync reads at most                        |

## Pipeline

1. **`syncCiJobs({ forge, store, repo, since, syncedFrom?, limit })`** — the first run, or one asking further back than any earlier full sync (`syncedFrom`, kept in the previous record's `history` and read even from records in an older shape), reads every job since `since`; later runs read from a day before the newest stored job, so jobs that were still running get their final status. Reads go through `listProjectJobRuns`; forges without it fall back to `listPipelineRuns` and `listJobRuns` per pipeline (newest 300). Only finished attempts (`success`, `failed`, `canceled`) are stored.
2. **`analyzeCiJobs(records, { from, to, defaultBranch? }, options)`** — pure; the computations below over the stored attempts of the window.
3. **`problemJobs(data, limit = 5)`** and **`jobProblems(job)`** — the problem list and the problems of one job.
4. **`ciJobsAnalysis`** / **`ciJobsReport(data, { previous?, repo?, ref? })`** — the report. `ciJobsDataSchema` (zod) validates uploads and drops unknown fields; `readCiJobs(data)` reads a stored record and returns `undefined` for one in an older shape, which lists and reports treat as no data.

## Computations

Durations are seconds, rates percentages, weeks start on Monday (UTC).

- **Attempts and finals**: the attempt with the highest job id per pipeline and job name is final; earlier ones were retried.
- **Pipelines**: the headline numbers describe the default branch's pipelines (`pipelines.ref`), or `options.branch` when set, or every pipeline when the default branch has none. **Pipeline time** is how long any job of a pipeline was running (the union of its attempts' run times, retries included), so idle gaps such as a manual job started days later do not count; it is measured on passing pipelines (median, p90, and per week). **Success rate** is the share of pipelines where no final attempt of a job not allowed to fail failed. **Queue** is the queue time of their attempts. **Change** compares the median of the last 7 days with the 7 days before.
- **Stage order**: forges number jobs as a pipeline creates them, stage by stage, so the stage whose first job has the lower id runs earlier; each stage scores wins minus losses against the others across pipelines, ties by name. Jobs are listed in stage order, then by name.
- **Per job**: durations of successful attempts (median, p90, weekly median), **failure rate** over final attempts (jobs allowed to fail and canceled ones left out), **retried** (share of pipelines needing more than one attempt), **flaky** (pipelines where an attempt failed and a later one passed).
- **Trend**: the median of the last `recentDays` against the median of the window before them. `slower`/`faster` needs at least five successful runs on each side and a change of `changePercent` and `minChangeSeconds`; `new` has no earlier runs, `idle` no recent ones, everything else is `stable`.
- **Change point** (slower and faster jobs): over daily medians, the day where the mean before and after differs most in the trend's direction, weighted towards balanced splits, with at least three days on each side. It names the first run of that day: time, commit and link.
- **Problems** (`jobProblems`): `failing` from a 10% failure rate with at least two failures (never for jobs allowed to fail), `slower` from the trend, `flaky` from two pipelines that passed only on retry. `problemJobs` takes the worst failing (by failure rate), slower (by extra time across its runs) and flaky (by flaky pipelines) job in turn, each job once, up to `limit`, with a one-line reason ("fails in 23% of runs", "+40% since 12 Oct (1m 40s → 2m 20s)", "passed only on retry in 3 pipelines, retried in 18% of them") and a link to the run where a slowdown started or the job's last run.

## Data

```ts
interface CiJobsData {
  window: { from; to; days }
  options: CiJobsOptions
  defaultBranch?: string
  history: { oldest?; newest?; jobs; syncedFrom? }
  lastRunAt?: string
  pipelines: { ref?; count; successRate?; duration: Spread; queue: Spread; change? }
  weeks: { week; pipelines; median?; p90? }[]
  stages: string[] // in run order
  jobs: JobStats[] // stage order; per job: duration, rates, trend, changePoint?, weekly medians, last run
}
interface Spread {
  samples
  median?
  p90?
}
```

## Report

`kind: 'ci-jobs'`, label `CI jobs`. Metrics (with deltas against the previous record): pipeline time median, success rate, queue median. Sections, matching the CI page:

1. **Problem jobs** — `problemJobs` as issues.
2. **Pipeline time per week** — median and p90 of passing pipelines.
3. **Jobs** — every job in stage order: runs, median with a weekly sparkline, p90, recent change, failure rate.
4. **Reliability** — jobs that failed or passed only on retry, worst failure rate first.

A record in an older shape renders a short "older format" notice and no metrics.

## Limitations

- Stored attempts are never pruned by the analyzer; `CiJobStore.prune` is there for retention.
- A full sync of a very busy repository stops after `maxJobs` attempts.
- Pipeline time is measured from jobs, so jobs that never started (skipped, manual) do not count, and the forge's own pipeline duration may differ.
- GitLab `needs:` edges are not stored, so the pipeline picture shows stages, not the job graph.
