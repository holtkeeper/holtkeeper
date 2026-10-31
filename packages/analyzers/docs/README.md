# @holtkeeper/analyzers

The registry of analyzers Holtkeeper ships. The server's job engine and the CLI's `analyze` command run them; each implements the `Analyzer` contract of [@holtkeeper/analyzer](../../analyzer/docs/README.md).

```ts
import { builtinAnalyzers } from '@holtkeeper/analyzers'
```

| Kind           | Scope | What it produces                                                          |
| -------------- | ----- | ------------------------------------------------------------------------- |
| `changelog`    | repo  | what changed between two releases, grouped by type and scope              |
| `bundle`       | repo  | app builds and published packages: size per entrypoint, asset, release    |
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
| `warmup`       | repo  | runs a command of your choosing to fill build caches (Turborepo, Nx, ...) |
| `audit`        | repo  | vulnerability audit with osv-scanner (data is an `AuditReport`)           |

`reviewChecks()` returns the quality checks the review analyzer runs on changed lines.

## bundle

Measures what a repository ships as targets of one record ([@holtkeeper/bundles](../../bundles/docs/README.md#targets)): app builds and the versions of packages it publishes. It needs a checkout; the forge (`npmRegistry`), forge access (the token and rate-limited `fetch` for the forge's own registry) and history are `optional`, so the CLI runs it too: there packages are read anonymously and versions measured before are not skipped.

- **Builds.** `targets: [{ name, dir = '.', build?, dist?, entries? }]`, or the `dist`/`build` shorthand for one `app` target at the root. Without either, every package of the checkout that is the root or `private`, has a `build` script and either a Vite, webpack, Rspack, Rsbuild or Rollup config (`<tool>.config.*`) or a `build` script that calls one of them (`NODE_ENV=production webpack --config webpack.mjs`) is a target (`app` at the root, else the package name). One build with several entries (desktop, mobile, replay, ...) is one target whose entrypoints come from the bundler's manifest; set `entries` to name them by output globs instead. Dependencies are installed once from the root lockfile (`install`, `installScripts`, as in [@holtkeeper/coverage](../../coverage/docs/README.md)), then each target runs `build` (default `<package manager> run build`, `CI=true`, `NODE_ENV=production`, 20 minutes) through the job's runner and measures `dist` (default the first of `dist`, `build`, `out`). A failed install is logged; a failed build or a missing output becomes a `failed` target with the error, so releases that no longer build are gaps, not failed jobs. Builds need network for the install: set the `toolchain` setting's `network` to `full` in `container` execution.
- **Packages.** Every workspace package that is not `private` and has a version (`packages` / `excludePackages` globs narrow it) is measured at the version its `package.json` has at the ref, plus up to `history` earlier published versions (prereleases only with `includePrereleases`). Archives come from the first registry that has the version, in this order: `registries` (`{ '@scope': url, '*': url }`), the package's `publishConfig.registry`, `@scope:registry=` / `registry=` of the package's and the root's `.npmrc`, the forge's own registry for the repository (GitLab: the project's npm endpoint), npmjs. Requests to the forge's host go through the forge's `fetch` (its per-token limits) with the forge token as a bearer token; other registries are read anonymously (or through the egress proxy). Versions earlier records measured are skipped, so a record holds only new versions; each measured version is also kept in the run cache.
- `source`: `auto` (default: both), `build` or `packages`. Flags: `--source`, `--dist`, `--build`, `--history`.
- **Applies** when the root `package.json` names workspaces, `publishConfig`, `exports` or a bundler dependency, or a `pnpm-workspace.yaml` exists.

## audit

Options: `fix` (default `false`: report only; `true` runs `osv-scanner fix`, the JavaScript and the Go fixers in the checkout and rescans), `allowlist` (entries of [@holtkeeper/vuln](../../vuln/docs/README.md#allowlist)) and `traits` for conditional entries. Commands go through the job's runner, so they run in the job's sandbox. `auditAnalysis` renders the report with counts per severity and a findings table; the server also stores each finished audit job as an audit run.
