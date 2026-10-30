# @holtkeeper/coverage

The `coverage` analyzer and analysis kind: runs a checkout's tests with coverage (or reads an existing report) and records line, function and branch coverage per source file, so coverage can be followed per folder and file across runs.

## Public API

- `coverageAnalyzer` — `Analyzer<CoverageData, CoverageOptions>`, kind `coverage`, scope `repo`, needs `checkout`. Options (`coverageOptionsSchema`):
  - `file?: string` (`--file`) — an lcov tracefile or Go cover profile in the checkout to read instead of running the tests, e.g. a report CI left behind.
  - `exclude: string[]` (`--exclude`, comma-separated) — glob patterns of files to leave out, e.g. `src/generated/**`.
  - `untested: boolean` — default true: source files no test loaded count as fully uncovered.
- `coverageAnalysis` — the `AnalysisKind` (`schema: coverageDataSchema`, `summarize`, `toReport(current, previous)`); `coverageReport(data, { previous?, ref?, compareTo?, generatedAt? })` builds the report directly, `coverageTree(files)` the folder treemap, `coverageTone(percent)` the tone of a share.
- `analyzeCoverage({ dir, runner, file?, collectors?, exclude?, untested?, signal? }): Promise<CoverageData>` — collects and normalizes. `collectors` replaces the detected ones (any `CoverageCollector` from `@holtkeeper/quality-tests`).
- Helpers: `percentOf(counts)`, `sumCounts(parts)`.

## How coverage is collected

The same collectors as the `tests` quality check (`@holtkeeper/quality-tests`): the primary framework of each language is detected and run with lcov or Go coverage through the `CommandRunner` (`bun test`, vitest, jest, c8 + mocha, `node --test`, pytest-cov, `go test -coverprofile`). Nothing is installed; dependencies must be present in the checkout. Failing tests are fine as long as a report is written; collectors that fail are skipped, and the run fails only when none produced a report.

Then, per file:

- Test files, configs, declarations and generated files by name, paths outside the checkout and `exclude` matches are dropped.
- Lines are `DA` records (Go: statements' lines), functions `FN`/`FNDA` (Go: `go tool cover -func`), branches `BRDA` with a taken count above zero.
- With `untested`, source files of the report's languages that the report does not mention (and that are not generated or type-only) are added with every code line (non-blank, non-comment) uncovered and `loaded: false`. That count includes lines the tools would not call executable, such as imports, so it errs on the side of more uncovered lines.

`quality` keeps running its own `tests` check; the default `quality-weekly` schedule skips it (`coverage: skip`), and `coverage` is not on a default schedule: it runs whole test suites, and jobs install tools but not a project's dependencies, so JavaScript runners such as vitest or jest are missing from a fresh checkout. Schedule it for repositories whose tests run that way (Go, Bun without dependencies) or point `file` at a report CI produces.

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
