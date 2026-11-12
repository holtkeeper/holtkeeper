# Settings › Analyzers

Part of the web app's [Settings](README.md#settings) docs.

Route `/settings/analyzers`, body `features/settings/sections/AnalyzersSection.tsx`, logic in `lib/analyzer-catalog.ts`, endpoints and hooks in `api/settings-analyzers.ts`. Ops › Automation's ghost **Configure** leads here; the analyzer pages keep their own Configure drawers for the same `analyzers.<kind>` entries.

## Table

Every analyzer `GET /api/jobs/analyzers` lists, grouped by the workspace its records feed (`analyzerAreas`: Supply chain, Quality, Releases and knowledge, Other for kinds the panel does not know), sorted by label inside a group. Columns:

- **Analyzer**: label, `kind` in mono, an AI tag when it needs an agent.
- **State**, read from Automation, never a separate switch (`analyzerRows`): **On** when freshness refreshes it (it has `refresh` and the every-repository freshness entry is not `off`) or an enabled trigger, schedule or merge request policy queues it for every repository; **Some repositories** when enabled rules queue it for some groups only; **Off** when it runs only when someone starts it. Rules that only react to new repositories do not count.
- **Scope · runs when**: "Every repository", the groups, or "Only when started", over freshness's cadence and the titles of the rules that queue it.
- **Last 7 days** from `GET /api/jobs/analyzers/health` (`healthSummary`): "No runs", "4 runs, all fine", "1 of 4 failed" (danger when at least half failed) or "2 stopped by budget", with the repositories (or groups) it ran on.
- **Overrides**: entries of `analyzers.<kind>` narrower than the organization's.

Above it: state tabs with counts (All, On, Some repositories, Off), a search over label and kind, **Area** and **Uses AI** filters, and a strip with analyzers, overrides, AI analyzers, how many need a look (failed or budget-stopped runs) and the last run. Automation (triggers, schedules, groups) is read only with global `settings:read`; without it every analyzer's state comes from freshness alone. Health needs `analyses:read` and counts only jobs the viewer may read.

## Sheet

The header's primary **Run analyzer…** (`useRunJob`, `analyses:run`) opens the run dialog. A row opens a side sheet (`?item=<kind>&tab=runs|options|overrides`, J and K step through the shown rows) with the quiet action **Run now** (the run dialog for that analyzer, `analyses:run`), **Show runs** in the ⋯ menu (`/ops/runs?analyzer=<kind>`), the state, where and when it runs, the week's health with the median duration, and three tabs:

- **Runs**: the newest 20 jobs of the analyzer the viewer may read, each linking to `/ops/runs/$jobId`, plus a link to Ops › Runs filtered by the analyzer.
- **Options**: `SettingEntries` for `analyzers.<kind>`, the same editor the page drawers open (`useConfigure`), with every entry per scope.
- **Overrides**: the same editor limited to entries narrower than the organization's; a new entry starts without a scope so it must name groups or repositories.

Analyzers without an `analyzers.<kind>` setting (run-only ones such as `guide`) say they have no options.

## Tests

`lib/analyzer-catalog.test.ts`: state, scope and triggers from rules and freshness, overrides, counts, filters and health words.
