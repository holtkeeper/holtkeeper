# @holtkeeper/analyzers

The registry of analyzers Holtkeeper ships. The server's job engine and the CLI's `analyze` command run them; each implements the `Analyzer` contract of [@holtkeeper/analyzer](../../analyzer/docs/README.md).

```ts
import { builtinAnalyzers } from '@holtkeeper/analyzers'
```

| Kind           | Scope | What it produces                                                          |
| -------------- | ----- | ------------------------------------------------------------------------- |
| `changelog`    | repo  | what changed between two releases, grouped by type and scope              |
| `bundle`       | repo  | what a frontend build ships, per entrypoint, asset and package            |
| `depgraph`     | repo  | dependency graph (JavaScript, Go): cycles, duplicate versions, statistics |
| `quality`      | repo  | conventions, lint, duplication, dead code, secrets and test gaps          |
| `coverage`     | repo  | line, function and branch test coverage per source file                   |
| `testids`      | repo  | interactive elements of frontend templates with and without test ids      |
| `api-surface`  | repo  | public API of every package per version, for agents and semver checks     |
| `licenses`     | repo  | third-party licenses judged against allow and deny lists                  |
| `release-risk` | repo  | how risky a release is, from the analyses already stored                  |
| `fleet`        | group | shared library versions and config drift across a group                   |
| `stack`        | group | runtimes, package managers and images: versions, lag and end of life      |
| `assets`       | repo  | asset inventory checked against budgets, with smaller formats suggested   |
| `delivery`     | repo  | DORA metrics, CI health and merge request flow                            |
| `branches`     | repo  | branches to clean up: merged, closed unmerged or stale, per author        |
| `ci-jobs`      | repo  | CI job durations and failures over time                                   |
| `i18n`         | repo  | translation gaps per locale                                               |
| `propagate`    | group | package updates rolled out across a group, with fixes for what breaks     |
| `port`         | group | a change ported to the sibling repositories of a group                    |
| `review`       | repo  | AI review of a merge request                                              |
| `tracker`      | group | declared entities tracked across repositories and documents               |
| `audit`        | repo  | vulnerability audit with osv-scanner (data is an `AuditReport`)           |

`reviewChecks()` returns the quality checks the review analyzer runs on changed lines.

## audit

Options: `fix` (default `false`: report only; `true` runs `osv-scanner fix`, the JavaScript and the Go fixers in the checkout and rescans), `allowlist` (entries of [@holtkeeper/vuln](../../vuln/docs/README.md#allowlist)) and `traits` for conditional entries. Commands go through the job's runner, so they run in the job's sandbox. `auditAnalysis` renders the report with counts per severity and a findings table; the server also stores each finished audit job as an audit run.
