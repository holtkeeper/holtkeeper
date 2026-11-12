# CI

Part of the web app's [Quality](README.md#quality) docs.

**CI** (`/quality/ci`, `features/ci`, Quality workspace, shown with `analyses:read`) shows the newest `ci-jobs` record of each repository with CI runs in the last 30 days; it has no list of nightly records and no compare.

`CiPage` is a `FleetTable` over `GET /api/ci` (`CiRepoCard`, which carries its groups for the scope switch):

- **Toolbar.** The `ScopeSwitch` (_My teams_ folds other teams' rows into one row with their failing, flaky and healthy counts), a path or group search, two fixed labels _Branch: default_ and _Last 30 days_ (the analyzer sets the branch and window, so they do not filter), a **Status** filter and **Problems only**. Filters and the sorted column live in the URL (`parseCiSearch`: `q`, `status`, `problems`, `sort`, `dir`, plus `repo` for the sheet).
- **Strip** (`ciKpis` over the rows in scope): repositories, the median of their median and p90 pipeline times, the success rate over all their pipelines, flaky jobs, the median queue time and counts per state (failing, flaky, slower, healthy, idle when present).
- **Columns.** Repository (links to the hub's Quality › CI; groups and branch under it), Status in words (`ciStatusLabel`), median pipeline time, its change (`changeLabel`: `↑ 12% slower` reads as bad, under 5% stays neutral), a sparkline of the last 8 weekly medians, p90, success rate, flaky jobs, median queue time, pipelines and the last pipeline's age. Rows sort worst state first, then lowest success rate (`worstCiFirst`); headers re-sort (`ciSortValue`).

Under it a second `FleetTable` (`CiFleetJobs`) lists the worst jobs across the repositories from `GET /api/ci/jobs/fleet`, switched between **Slowest**, **Least reliable** and **Got slower**: job with its problem tags, repository (to the hub's Quality › CI), stage, median, p90, change, failure rate, passes on retry, runs and a link to the last run, with the scope switch folding other teams and a _Showing N of M jobs · read nightly_ footer.

A row opens `CiSheet` (`?repo=`, J/K step through the rows), which reads `GET /api/ci/repo`. The header shows the forge, the pipeline outcomes as the progress bar (`outcomeBar`: passed, failed, canceled), **Re-read pipelines** (runs `ci-jobs`), **Release gates** (to Releases › Flow setup, only when the card carries a release gate) and, in the ⋯ menu, **Open repository** (the record is behind **Open as page**); the body starts with the state, groups, branch, pipeline count and the newest run. Tabs:

1. **Overview**: job duration by stage (`stageBars`: one bar per job in run order, median solid over p90, scaled to the slowest p90, with problem tags), the problem jobs (at most five from the view, each with a reason and a link to the run), the pipeline numbers (time with its change, p90, queue, window, when it was read and the release-gate fact from `CiRepoCard.releaseGate`, present only with `releases:read`), and pipeline time per week as a line chart through the report `BlockView`.
2. **Jobs**: the table from `GET /api/ci/jobs` (median, p90, change, failure rate, passes on retry, runs, problem tags, a link to the last run), with how many of all jobs it shows.
3. **Problems**: the problem list, then jobs flagged with other problem kinds (`moreFlagged`).
4. **Reliability**: jobs that failed or passed only on retry, worst failure rate first (`unreliableJobs`).

Without a record in the current format the sheet says so and offers **Run now**. `CiRepoSection` is the same body for one repository in the hub's Quality tab, with the outcome bar, **Full record** and **Re-read pipelines**. Helpers live in `lib/ci.ts`.
