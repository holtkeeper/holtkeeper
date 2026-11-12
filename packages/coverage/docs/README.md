# @holtkeeper/coverage

The `coverage` analyzer and analysis kind: runs a checkout's tests with coverage (or reads an existing report) and records line, function and branch coverage per source file, so coverage can be followed per folder and file across runs.

## Public API

- `coverageAnalyzer` — `Analyzer<CoverageData, CoverageOptions>`, kind `coverage`, scope `repo`, needs `checkout`. Options (`coverageOptionsSchema`):
  - `file?: string` (`--file`) — an lcov tracefile or Go cover profile in the checkout to read instead of running the tests, e.g. a report CI left behind.
  - `exclude: string[]` (`--exclude`, comma-separated) — glob patterns of files to leave out, e.g. `src/generated/**`.
  - `untested: boolean` — default true: source files no test loaded count as fully uncovered.
  - `components: boolean` — default false: component files (`.tsx`, `.jsx`) are left out, so components need no tests; turn it on per repository or group through the `analyzers.coverage` setting.
  - `install: boolean` — default true: install JavaScript dependencies first when `node_modules` is missing (see below).
  - `installScripts: boolean` (`--install-scripts`) — default false: let that install run lifecycle scripts, for projects whose tests need `postinstall` output (Prisma clients, generated code).
  - `build: boolean` — default true: build workspace packages whose entry files are missing before the tests (see below).
  - `target: number` — default 60 (`DEFAULT_COVERAGE_TARGET`): line coverage, in percent, the repository should reach. It changes nothing in the run; stored metrics and repository health judge coverage by it. Set it per repository or group in the `analyzers.coverage` setting (`coverageTargetSchema` validates it: a number or numeric string from 0 to 100; null and empty strings fall back to 60).
- `coverageAnalysis` — the `AnalysisKind` (`schema: coverageDataSchema`, `summarize`, `metrics`, `toReport(current, previous)`); `coverageReport(data, { previous?, ref?, compareTo?, generatedAt? })` builds the report directly, `coverageTree(files)` the folder treemap, `coverageTone(percent)` the tone of a share.
- `analyzeCoverage({ dir, runner, file?, collectors?, exclude?, untested?, install?, installScripts?, build?, log?, signal? }): Promise<CoverageData>` — installs, collects and normalizes. `collectors` replaces the detected ones (any `CoverageCollector` from `@holtkeeper/quality-tests`).
- `installDependencies({ dir, runner, scripts?, retryDelayMs?, signal? }): Promise<InstallOutcome>` — `skipped` (with a reason), `installed` or `failed` (with the last lines of output); a failure that looks like a network error (`npm error network`, `ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`, `ENOTFOUND`, registry 5xx) is retried once after `retryDelayMs` (5 s); never throws for a failed install. `frozenInstallCommand(manager, scripts)` is the command.
- `buildWorkspaces({ dir, runner, signal? }): Promise<BuildOutcome>` — `skipped`, `built` or `failed` (with the packages built before and the last lines of output); never throws for a failed build. `unbuiltWorkspaces(dir)` lists what it would build, in dependency order.
- Helpers: `percentOf(counts)`, `sumCounts(parts)`.

## How coverage is collected

Jobs install tools but not a project's dependencies, so first, unless `install` is off or `file` is given, `installDependencies` installs JavaScript dependencies when the checkout has a `package.json` and a root lockfile but no `node_modules`: `npm ci`, `bun install --frozen-lockfile`, `pnpm install --frozen-lockfile`, `yarn install --immutable` (berry) or `yarn install --frozen-lockfile` (classic), with `--ignore-scripts` (and `npm_config_ignore_scripts`/`YARN_ENABLE_SCRIPTS`) unless `installScripts`, `CI=true`, 10 minutes at most. The package manager comes from the lockfile and `packageManager` (`detectPackageManager` from `@holtkeeper/vuln-js`). A failed install is logged and does not stop the run; when no collector then produces a report, the error names the failed install. The install needs network to the registry: in `container` execution with the `install` network policy the job container has none, so set the `toolchain` setting's `network` to `full` for those repositories. Private registries need credentials the job does not get: route jobs through an egress proxy that adds them (`jobs.execution.egress`, [docker/egress-proxy](../../../docker/egress-proxy/README.md)). Python and other ecosystems are not installed; Go downloads modules itself.

Monorepo tests often import sibling workspace packages through their build output (`main: lib/index.js`), which a fresh checkout does not have. So next, unless `build` is off or `file` is given, `buildWorkspaces` finds the workspace packages (`workspaces` in `package.json`, plain or `{ packages }`, and `pnpm-workspace.yaml`) whose `main`, `module`, `types` or `typings` file is missing and that have a `build` script, and runs `<pm> run build` in each, dependencies first, 10 minutes each at most. The first failing build stops the step and is logged; the tests run anyway.

Then the collectors of `@holtkeeper/quality-tests`: the primary framework of each language is detected and run with lcov or Go coverage through the `CommandRunner` (`bun test`, vitest, jest, c8 + mocha, `node --test`, pytest-cov, `go test -coverprofile`). Failing tests are fine as long as a report is written; collectors that fail are skipped, and the run fails only when none produced a report.

Then, per file:

- Test files, configs, declarations and generated files by name, component files unless `components`, paths outside the checkout and `exclude` matches are dropped.
- Lines are `DA` records (Go: statements' lines), functions `FN`/`FNDA` (Go: `go tool cover -func`), branches `BRDA` with a taken count above zero.
- With `untested`, source files of the report's languages that the report does not mention (and that are not generated or type-only) are added with every code line (non-blank, non-comment) uncovered and `loaded: false`. That count includes lines the tools would not call executable, such as imports, so it errs on the side of more uncovered lines.

Tests run once a week, in the default `tests-weekly` schedule (Wednesday nights, with `testids`).

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
- **Changes** (with a previous analysis) — files whose line coverage moved by 1% or more, new files counted from zero.

## Metrics

`coverageMetrics(data, { options?, previous? })` is the kind's `metrics`, stored with every record as `CoverageMetrics`:

- `percent`, `functions`, `branches` — shares over every file, rounded to 0.01; absent when there is nothing to cover.
- `delta` — `percent` minus the previous record's, in percentage points; absent without both.
- `target` — `options.target`, or 60 when unset or invalid (`coverageTargetOf(options)`). Whether `percent` reaches it is judged where it is shown (repository health), not stored.
- `files`, `untested` — source files, and those no test loaded.
- `tools` — the tools that produced the record.
- `totals` — `coverageTotals(data)`: covered and total lines, functions and branches, files, untested files and their lines.

`tools` and `totals` are what Quality › Coverage cards show, so the overview reads metrics only. Records written before they existed lack them; the server recomputes them from the newest record's data until the next run replaces it.

## Summaries

`summary.ts` holds the pure helpers Quality › Coverage and the report share:

- `coverageTotals(data)` — lines, functions, branches, file count, files no test loaded and their lines.
- `coverageGroupOf(file)` / `coverageGroups(files)` — coverage per workspace package (`packages/<name>`, `apps/<name>`, `libs/<name>`, …) or top-level folder, `ROOT_GROUP` (`.`) for files in the root, most uncovered lines first.
- `worstFiles(files, limit = 10)` — files with the most uncovered lines.
- `coverageChanges(data, previous, minPoints = 5)` — files whose line coverage moved by at least `minPoints`, largest move first; new files count from zero.
- `changedFilesCoverage(data, previous)` — line coverage of the files that are new or whose counts differ: the coverage of what changed between two records.

The web panel shows them in **Quality › Coverage** (`/quality/coverage`), one card per repository with a side sheet for the breakdown.
