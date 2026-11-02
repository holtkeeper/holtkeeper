# @holtkeeper/quality-duplication

The `duplication` quality check: copy-paste detection with [jscpd](https://jscpd.dev) 5 (the Rust engine; the npm package ships a native binary per platform).

## Public API

- `duplicationCheck({ minTokens?, minLines?, formats?, ignore?, tests?, large?, bin?, timeoutMs? }): QualityCheck` — check named `duplication`, always detected. It runs jscpd in the project directory through the context's `CommandRunner` and returns:
  - `duplication` — `{ percentage, duplicatedLines, totalLines }` from jscpd's totals;
  - `issues` — one per clone, category `duplication`, rule `clone/<kind>` (`clone/exact`, ...), on the first copy's lines; `message` names both locations (`13 lines (93 tokens) duplicated in src/a.ts:1-13 and src/b.ts:1-13`), `help` points at the other copy. Severity is `info`, or `warning` for clones of at least `large.lines` (50) lines or `large.tokens` (400) tokens. The id is built from both files and the duplicated text, so it survives the code moving; repeats of the same text between the same two files are numbered in report order, so every issue has its own id;
  - `version` — jscpd's version.
- `jscpdCommand(options, outputDir)` — the command line it runs.
- `parseJscpdReport(report, large?)` and `jscpdReportSchema` — the JSON report parser, usable on reports produced elsewhere.
- `defaultIgnore` — globs skipped on top of `.gitignore`; `testIgnore` — tests and stories, skipped unless `tests`; `defaultMinTokens` — 100.

## How it runs

```
<jscpd> --reporters json --output <tmp> --silent --no-colors --ignore <defaultIgnore + testIgnore + ignore> --min-tokens N [--min-lines N] [--format a,b] .
```

- The binary is the native jscpd executable of the platform package (`jscpd-linux-x64-gnu`, `jscpd-darwin-arm64`, ...) that this package's jscpd dependency installed, unless `bin` is given. The package's own `bin` is a `#!/usr/bin/env node` launcher, and the worker image has no Node.js; it is used only when no native binary is found.
- `.gitignore` is respected (jscpd's default). `defaultIgnore` adds `node_modules`, `dist`, `build`, `vendor`, `coverage`, `.git`, minified JS, lockfiles (`*.lock`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `go.sum`, `Cargo.lock`, `poetry.lock`, ...) data and asset files (`*.json`, `*.svg`, `*.map`, snapshots): sprite sheets, animation skeletons and icons repeat by nature and would otherwise dominate the percentage; Markdown, YAML and templates (`*.tpl`, `*.gotmpl`: generated changelogs, Helm charts and values, CI and dashboard configs); HTML (generated API docs, static pages); and generated code (`generated/`, `__generated__/`, `*.pb.*`, `*_pb.*`, `*_pb2.py`, `*.generated.*`).
- `testIgnore` (`__tests__/`, `__mocks__/`, `*.test.*`, `*.spec.*`, `*_test.go`, `test_*.py`, `*.stories.*`, `*.story.*`) is skipped unless `tests: true`: repeated setup in tests is usually deliberate.
- Issues come largest first, so the clones that matter survive when a report keeps only its first findings.
- A project's own `.jscpd.json` is still read by jscpd; options given here override it on the command line. Exit code 1 (threshold exceeded) still counts as a run when the report was written.
- The report is written to a temporary directory on the machine running this code and removed afterwards, so the runner must share that filesystem.
- `minTokens`, `minLines` and `formats` map to jscpd's `--min-tokens` (default `defaultMinTokens`, 100: smaller clones are mostly imports, props and boilerplate), `--min-lines` (default 5) and `--format` (format names such as `typescript`, `go`, `python`; `jscpd --list` shows them).
