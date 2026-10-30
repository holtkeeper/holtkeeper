# @holtkeeper/delivery

Delivery analytics for one repository: DORA metrics, CI health and merge request flow. Data comes from the optional insight reads of `GitForge` (`listMergeRequests`, `listDeployments`, `listTags`, `listPipelineRuns`, `listJobRuns`), so no checkout is needed. Produces serializable `DeliveryData` and a `delivery` analysis kind that turns it into a universal `Report`.

## Analyzer

`deliveryAnalyzer` (`kind: 'delivery'`, scope `repo`, `needs: { forge: true }`). `createDeliveryAnalyzer({ now?, limits? })` builds one with another clock or fetch caps.

| Option                  | Flag               | Default      | Meaning                                                              |
| ----------------------- | ------------------ | ------------ | -------------------------------------------------------------------- |
| `days`                  | `--days`           | `90`         | Window length, ending now                                            |
| `productionEnvironment` | `--environment`    | `production` | Environment whose deployments are releases                           |
| `failureWindowHours`    | `--failure-window` | `24`         | How long after a release a failure signal is blamed on it            |
| `staleDays`             | `--stale-days`     | `7`          | Open merge requests idle this long are stale                         |
| `maxPipelines`          | `--max-pipelines`  | `300`        | Newest pipelines of the window to fetch (one request each on GitLab) |
| `jobPipelines`          | `--job-pipelines`  | `100`        | Newest finished pipelines whose jobs are fetched                     |

## Pipeline

1. **`collectDelivery({ forge, repo, settings, now, limits? })`** — fetches merge requests updated in the window plus all open ones, production deployments, tags, pipelines and job attempts into a `DeliveryInput`. A read the forge does not implement yields an empty list and a note.
2. **`analyzeDelivery(input, options)`** — pure; runs the computations below and returns `DeliveryData`. `deliveryDataSchema` (zod) validates uploads.
3. **`deliveryAnalysis`** / **`deliveryReport(data, { previous?, repo?, ref? })`** — the report.

## Computations

All pure, on ISO 8601 times; durations are seconds.

- **Releases** (`deployEvents`): successful and failed deployments to the production environment (time: `finishedAt`, else `createdAt`). Without any in the window, tags (tag creation, else commit date) count as releases; without tags, successful pipelines on the default branch. `dora.source` says which was used. Only real deployments can fail.
- **Deployment frequency**: successful releases per week of the window.
- **Lead time for changes**: for each merge request merged into the default branch in the window, from creation (or `firstCommitAt` when the forge gives it) to the first successful release at or after the merge; also split into created → merged and merged → deployed. Merges with no later release count as `undeployed`. Median and p90.
- **Change failure rate** (`failureSignals`, `blameFailures`): signals are failed deployments, merged revert/rollback merge requests (title starting with `Revert`/`Rollback`, or a `revert`/`rollback` label) and merged hotfix merge requests (label containing `hotfix`, or a `hotfix/` branch). Each signal is blamed on the last successful release at most `failureWindowHours` before it; the rate is blamed releases over successful releases.
- **Time to restore** (`restoreTimes`): from each signal (failed deployment, or creation of the fixing merge request) to the first successful release after the fix (after the failed deployment, or after the merge). Signals that start before the previous incident is restored join it. Unresolved incidents are counted, not timed.
- **Bands** (DORA): deployment frequency elite ≥ 7/week, high ≥ 1/week, medium ≥ 1/month, low below; lead time elite < 1 day, high < 1 week, medium < 30 days; change failure rate elite ≤ 5 %, high ≤ 10 %, medium ≤ 15 %; time to restore elite < 1 hour, high < 1 day, medium < 1 week. Tones: elite `good`, high `info`, medium `warning`, low `bad`.
- **CI health** (`computeCi`): pipelines created in the window; success rate over succeeded and failed pipelines (canceled, skipped, manual left out); duration and queue median/p95; weekly trend. Jobs: `slowestJobs` (median of successful attempts), `flakyJobs` (an attempt failed and a retry in the same pipeline passed, or final attempts on the same commit both passed and failed), `failingJobs` (final attempts, `allowFailure` jobs left out). Top 10 each.
- **Merge request flow** (`computeFlow`): open merge requests by age (< 1 day, 1–7, 7–30, > 30 days), drafts, stale ones (no update for `staleDays`, idle longest first), time to merge distribution (< 1 hour, 1–24 hours, 1–7 days, > 7 days) with median/p90, and changed files per merge request when the forge reports `changesCount`.

## Data

```ts
interface DeliveryData {
  window: { from; to; days }
  options: DeliveryOptions
  defaultBranch: string
  counts: { mergeRequests; deployments; tags; pipelines; jobs }
  notes: string[]
  dora: {
    source
    deployments
    failedDeployments
    deploymentsPerWeek
    leadTime
    timeToMerge
    timeToDeploy
    undeployed
    failedChanges
    changeFailureRate?
    timeToRestore
    bands
    weeks
    failures
  }
  ci: {
    pipelines
    finished
    successRate?
    duration
    queue
    weeks
    jobPipelines
    slowestJobs
    flakyJobs
    failingJobs
  }
  mergeRequests: { open; drafts; openByAge; stale; merged; timeToMerge; size? }
}
```

Distributions are `{ samples, median?, p90?, p95? }` in seconds; rates are percentages.

## Report

`kind: 'delivery'`, label `Delivery`. Metrics (with deltas against the previous record): deployments per week, lead time, change failure rate, time to restore (DORA band as tone and hint), pipeline success rate, pipeline duration median, flaky jobs, stale merge requests.

Sections:

1. **DORA** — the four metrics, a band table, a stacked bar chart of successful and failed changes per week, a line chart of weekly median lead time, the lead time breakdown, and the failures as issues (blamed release, restore time).
2. **Pipelines** — success rate, duration median/p95, queue median; line chart of weekly duration and queue, area chart of weekly success rate; tables of slowest, flaky and most failing jobs. Jobs not flaky or failing in the previous record are marked `new`; previously flaky jobs that are no longer flaky are listed.
3. **Merge requests** — open, drafts, stale, merged, time to merge; bar charts by age and time to merge; table of stale merge requests with links (new ones marked, resolved ones listed).
4. **Notes** — window, release source (deployments vs tags or pipelines fallback), what was fetched, missing forge reads, and the approximations below.

## Limitations

- Lead time pairs a merge with the first release after it; it does not check that the release contains the merge commit.
- GitLab's merge request list has no first commit date or size, so lead time starts at merge request creation and size is absent there.
- Only the newest `maxPipelines` pipelines and the jobs of `jobPipelines` of them are analyzed.
