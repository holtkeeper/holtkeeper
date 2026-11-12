# Analyzers

Part of the [@holtkeeper/server](README.md) docs.

Server side of Settings › Analyzers: analyzer health over seven days and the analyzer options the section shares with the analyzer pages.

## `GET /api/jobs/analyzers/health`

Answers `AnalyzerHealthList { days: 7, analyzers: AnalyzerHealthView[] }`, one row per analyzer the server runs, in the order of `GET /api/jobs/analyzers`, zeros for analyzers without jobs. Built by `analyzerHealth` (`job-stats.ts`) on `JobStore.count` and `JobStore.list`, narrowed to the repositories (and groups) whose jobs the caller may read with `analyses:read`, exactly as `GET /api/jobs` narrows; a caller with `analyses:read` over everything sees every job.

- `runs`: jobs created in the window that are not queued; `failed` and `blocked` (refused or stopped by the AI budget) count jobs in that state.
- `targets`, `lastRunAt` (when the newest finished, else started), `lastFailureAt` and `medianDurationMs` (started to finished, canceled jobs left out) come from the newest 500 started jobs of the analyzer in the window.

Any signed-in principal may call it; without `analyses:read` anywhere every count is zero.

## Options

Options are the `analyzers.<kind>` settings, written through `PUT /api/settings` or `POST /api/settings/draft` (see [policies.md](policies.md)) like every other setting. What makes an analyzer run (freshness, triggers, schedules, merge request policies) stays in Automation; the section reads it, the server has no enabled flag per analyzer.

## Tests

`test/analyzers-health.test.ts`: counts, targets, last runs and the median over the window, jobs older than seven days and queued jobs left out, and a grant on one group counting only that group's jobs.
