# @holtkeeper/coverage

The `coverage` analyzer and analysis kind: runs a checkout's tests with coverage (or reads an existing report) and records line, function and branch coverage per source file, so coverage can be followed per folder and file across runs.

## Public API

- `coverageAnalyzer` — `Analyzer<CoverageData, CoverageOptions>`, kind `coverage`, scope `repo`, needs `checkout`. Options (`coverageOptionsSchema`):
  - `file?: string` (`--file`) — an lcov tracefile or Go cover profile in the checkout to read instead of running the tests, e.g. a report CI left behind.
  - `exclude: string[]` (`--exclude`, comma-separated) — glob patterns of files to leave out, e.g. `src/generated/**`.
  - `untested: boolean` — default true: source files no test loaded count as fully uncovered.
  - `install: boolean` — default true: install JavaScript dependencies first when `node_modules` is missing (see below).
  - `installScripts: boolean` (`--install-scripts`) — default false: let that install run lifecycle scripts, for projects whose tests need `postinstall` output (Prisma clients, generated code).
- `coverageAnalysis` — the `AnalysisKind` (`schema: coverageDataSchema`, `summarize`, `toReport(current, previous)`); `coverageReport(data, { previous?, ref?, compareTo?, generatedAt? })` builds the report directly, `coverageTree(files)` the folder treemap, `coverageTone(percent)` the tone of a share.
- `analyzeCoverage({ dir, runner, file?, collectors?, exclude?, untested?, install?, installScripts?, log?, signal? }): Promise<CoverageData>` — installs, collects and normalizes. `collectors` replaces the detected ones (any `CoverageCollector` from `@holtkeeper/quality-tests`).
- `installDependencies({ dir, runner, scripts?, signal? }): Promise<InstallOutcome>` — `skipped` (with a reason), `installed` or `failed` (with the last lines of output); never throws for a failed install. `frozenInstallCommand(manager, scripts)` is the command.
- Helpers: `percentOf(counts)`, `sumCounts(parts)`.

## How coverage is collected

Jobs install tools but not a project's dependencies, so first, unless `install` is off or `file` is given, `installDependencies` installs JavaScript dependencies when the checkout has a `package.json` and a root lockfile but no `node_modules`: `npm ci`, `bun install --frozen-lockfile`, `pnpm install --frozen-lockfile`, `yarn install --immutable` (berry) or `yarn install --frozen-lockfile` (classic), with `--ignore-scripts` (and `npm_config_ignore_scripts`/`YARN_ENABLE_SCRIPTS`) unless `installScripts`, `CI=true`, 10 minutes at most. The package manager comes from the lockfile and `packageManager` (`detectPackageManager` from `@holtkeeper/vuln-js`). A failed install is logged and does not stop the run; when no collector then produces a report, the error names the failed install. The install needs network to the registry: in `container` execution with the `install` network policy the job container has none, so set the `toolchain` setting's `network` to `full` for those repositories. Private registries need credentials the job does not get: route jobs through an egress proxy that adds them (`jobs.execution.egress`, [docker/egress-proxy](../../../docker/egress-proxy/README.md)). Python and other ecosystems are not installed; Go downloads modules itself.

Then the same collectors as the `tests` quality check (`@holtkeeper/quality-tests`): the primary framework of each language is detected and run with lcov or Go coverage through the `CommandRunner` (`bun test`, vitest, jest, c8 + mocha, `node --test`, pytest-cov, `go test -coverprofile`). Failing tests are fine as long as a report is written; collectors that fail are skipped, and the run fails only when none produced a report.

Then, per file:

- Test files, configs, declarations and generated files by name, paths outside the checkout and `exclude` matches are dropped.
- Lines are `DA` records (Go: statements' lines), functions `FN`/`FNDA` (Go: `go tool cover -func`), branches `BRDA` with a taken count above zero.
- With `untested`, source files of the report's languages that the report does not mention (and that are not generated or type-only) are added with every code line (non-blank, non-comment) uncovered and `loaded: false`. That count includes lines the tools would not call executable, such as imports, so it errs on the side of more uncovered lines.

`quality` keeps running its own `tests` check; the default `quality-weekly` schedule skips it (`coverage: skip`), so tests run once a week, in the default `tests-weekly` schedule (Wednesday nights, with `testids`).

## Data

```ts
interface CoverageData {
  tools: string[] // collectors that produced a report
  languages: string[] // js, go, python
  summary: { lines: Counts; functions?: Counts; branches?: Counts } // over every file below
  files: {
    file: string // relative to the checkout
    lines: Counts
    functions?: Counts
    branches?: Counts
    loaded?: false // no test loaded the file
  }[]
}
interface Counts {
  covered: number
  total: number
}
```

## Report

- **Metrics** — line, function and branch coverage (`percent`, `better: 'up'`, good from 80%, bad below 50%), source files, files without tests (`better: 'down'`).
- **By folder** — treemap down to three levels, sized by lines to cover and colored by coverage.
- **Least covered files** — the 50 files with the most uncovered lines: line, function and branch share, `no tests` for files no test loaded.
- **Changes** (with a previous analysis) — files whose line coverage moved by 1% or more.

The web panel shows it under **Test coverage** (`/coverage`).
