# @holtkeeper/quality-duplication

The `duplication` quality check: copy-paste detection with [jscpd](https://jscpd.dev) 5 (the Rust engine; the npm package ships a native binary per platform).

## Public API

- `duplicationCheck({ minTokens?, minLines?, formats?, ignore?, large?, bin?, timeoutMs? }): QualityCheck` — check named `duplication`, always detected. It runs jscpd in the project directory through the context's `CommandRunner` and returns:
  - `duplication` — `{ percentage, duplicatedLines, totalLines }` from jscpd's totals;
  - `issues` — one per clone, category `duplication`, rule `clone/<kind>` (`clone/exact`, ...), on the first copy's lines; `message` names both locations (`13 lines (93 tokens) duplicated in src/a.ts:1-13 and src/b.ts:1-13`), `help` points at the other copy. Severity is `info`, or `warning` for clones of at least `large.lines` (50) lines or `large.tokens` (400) tokens. The id is built from both files and the duplicated text, so it survives the code moving; repeats of the same text between the same two files are numbered in report order, so every issue has its own id;
  - `version` — jscpd's version.
- `jscpdCommand(options, outputDir)` — the command line it runs.
- `parseJscpdReport(report, large?)` and `jscpdReportSchema` — the JSON report parser, usable on reports produced elsewhere.
- `defaultIgnore` — globs skipped on top of `.gitignore`.

## How it runs

```
<jscpd> --reporters json --output <tmp> --silent --no-colors --ignore <defaultIgnore + ignore> [--min-tokens N] [--min-lines N] [--format a,b] .
```

- The binary is this package's `node_modules/.bin/jscpd` unless `bin` is given.
- `.gitignore` is respected (jscpd's default). `defaultIgnore` adds `node_modules`, `dist`, `build`, `vendor`, `coverage`, `.git`, minified JS, lockfiles (`*.lock`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `go.sum`, `Cargo.lock`, `poetry.lock`, ...) and data and asset files (`*.json`, `*.svg`, `*.map`, snapshots): sprite sheets, animation skeletons and icons repeat by nature and would otherwise dominate the percentage.
- A project's own `.jscpd.json` is still read by jscpd; options given here override it on the command line. Exit code 1 (threshold exceeded) still counts as a run when the report was written.
- The report is written to a temporary directory on the machine running this code and removed afterwards, so the runner must share that filesystem.
- `minTokens`, `minLines` and `formats` map to jscpd's `--min-tokens` (default 50), `--min-lines` (default 5) and `--format` (format names such as `typescript`, `go`, `python`; `jscpd --list` shows them).
