# @holtkeeper/analyzers

The registry of analyzers Holtkeeper ships. The server's job engine runs them; each implements the `Analyzer` contract of [@holtkeeper/analyzer](../../analyzer/docs/README.md).

```ts
import { builtinAnalyzers } from '@holtkeeper/analyzers'
```

| Kind          | Scope | What it produces                                                          |
| ------------- | ----- | ------------------------------------------------------------------------- |
| `bundle`      | repo  | app builds and published packages: size per entrypoint, asset, release    |
| `depgraph`    | repo  | dependency graph (JavaScript, Go): cycles, duplicate versions, statistics |
| `coverage`    | repo  | line, function and branch test coverage per source file                   |
| `testids`     | repo  | test attributes frontend templates expose, per component                  |
| `api-surface` | repo  | public API of every package per version, for agents and semver checks     |
| `licenses`    | repo  | third-party licenses judged against allow and deny lists                  |
| `stack`       | group | runtimes, images and tools with end of life, and the group's conventions  |
| `assets`      | repo  | asset inventory checked against budgets, with smaller formats suggested   |
| `branches`    | repo  | branches to clean up: merged, closed unmerged or stale, per author        |
| `ci-jobs`     | repo  | CI job durations and failures over time                                   |
| `i18n`        | repo  | translation gaps per locale                                               |
| `propagate`   | group | package updates rolled out across a group, failures handed to fix tasks   |
| `review`      | repo  | AI review of a merge request                                              |
| `guide`       | repo  | generated Guide sections from repository evidence, hash-gated, proposed   |
| `tracker`     | group | declared entities tracked across repositories and documents               |
| `audit`       | repo  | vulnerability audit with osv-scanner (data is an `AuditReport`)           |
| `write-task`  | repo  | a code change pushed as a branch with a merge request (write worker pool) |

`guide` ([@holtkeeper/guide-generator](../../guide-generator/docs/README.md)), `review` and `write-task` ([@holtkeeper/write-task](../../write-task/docs/README.md), whose registry copy refuses every task) need server state; the server replaces these registry copies with ones built on its store.

`reviewChecks({ testids? })` returns the checks the review analyzer runs on changed lines: `secrets` and `testids`; `testids` takes the repository's `TestIdOverrides` from the `analyzers.testids` setting.

## bundle

Measures what a repository ships as targets of one record ([@holtkeeper/bundles](../../bundles/docs/README.md#targets)): app builds and the versions of packages it publishes. It needs a checkout; the forge (`npmRegistry`), forge access (the token and rate-limited `fetch` for the forge's own registry) and history are `optional`: without them packages are read anonymously and versions measured before are not skipped.

- **Builds.** `targets: [{ name, dir = '.', build?, dist?, entries? }]`, or the `dist`/`build` shorthand for one `app` target at the root. Without either, every package of the checkout that is the root or `private`, has a `build` script and either a Vite, webpack, Rspack, Rsbuild or Rollup config (`<tool>.config.*`) or a `build` script that calls one of them (`NODE_ENV=production webpack --config webpack.mjs`) is a target (`app` at the root, else the package name). One build with several entries (desktop, mobile, replay, ...) is one target whose entrypoints come from the bundler's manifest; set `entries` to name them by output globs instead. Dependencies are installed once from the root lockfile (`install`, `installScripts`, as in [@holtkeeper/coverage](../../coverage/docs/README.md)), then each target runs `build` (default `<package manager> run build`, `CI=true`, `NODE_ENV=production`, 20 minutes) through the job's runner and measures `dist` (default the first of `dist`, `build`, `out`). A failed install is logged; a failed build or a missing output becomes a `failed` target with the error, so releases that no longer build are gaps, not failed jobs. Builds need network for the install: set the `toolchain` setting's `network` to `full` in `container` execution.
- **Packages.** Every workspace package that is not `private` and has a version (`packages` / `excludePackages` globs narrow it) is measured at the version its `package.json` has at the ref, plus up to `history` earlier published versions (prereleases only with `includePrereleases`). Archives come from the first registry that has the version, in this order: `registries` (`{ '@scope': url, '*': url }`), the package's `publishConfig.registry`, `@scope:registry=` / `registry=` of the package's and the root's `.npmrc`, the forge's own registry for the repository (GitLab: the project's npm endpoint), npmjs. Requests to the forge's host go through the forge's `fetch` (its per-token limits) with the forge token as a bearer token; other registries are read anonymously (or through the egress proxy). Versions earlier records measured are skipped, so a record holds only new versions; each measured version is also kept in the run cache.
- `source`: `auto` (default: both), `build` or `packages`. Flags: `--source`, `--dist`, `--build`, `--history`.
- `budgets`: maximum JS and CSS gzip bytes per target name or glob, e.g. `{ app: 400000, '@acme/*': 50000 }`; the run ignores them, the stored metrics judge each target by them ([Metrics](../../bundles/docs/README.md#metrics)).
- **Applies** when the root `package.json` names workspaces, `publishConfig`, `exports` or a bundler dependency, or a `pnpm-workspace.yaml` exists.

## audit

Options: `fix` (default `false`: report only; `true` runs `osv-scanner fix`, the JavaScript and the Go fixers in the checkout and rescans), `allowlist` (entries of [@holtkeeper/vuln](../../vuln/docs/README.md#allowlist)) and `traits` for conditional entries. Commands go through the job's runner, so they run in the job's sandbox. `auditAnalysis` renders the report with counts per severity and a findings table; the server also stores each finished audit job as an audit run. Its `metrics` (`auditMetrics`) store `AuditMetrics`: active advisories (`findings`) and their counts per severity (`severities`, every severity present), allowlisted (`ignored`), expired allowlist entries (`expired`), advisories fixing removed (`resolved`), every active and allowlisted finding as `AuditFindingMetric` (`advisories`: advisory, aliases, summary, severity, package, ecosystem, version, source, fixed versions, and `allowlisted: { until? }` for those the allowlist hid) and `firstSeen`, when each finding was first reported on this line of history, keyed by `auditFindingKey` (advisory, ecosystem and package; not version or source). `firstSeen` carries a key over from the previous record's metrics and otherwise uses the record's `createdAt` from the metrics context; records stored before it existed have none, and a key is missing when no time is known. Fleet tables (the server's `GET /api/audits/findings`) read only these metrics, never the report.
