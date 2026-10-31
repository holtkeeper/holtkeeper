# @holtkeeper/quality-tests

The `tests` quality check: finds code that lacks tests, explains why it matters, and — with an agent — proposes an example test for the worst gaps.

```ts
import { analyzeQuality } from '@holtkeeper/quality'
import { testGapsCheck } from '@holtkeeper/quality-tests'

await analyzeQuality({ dir, checks: [testGapsCheck({ top: 10, examples: 3 })], agent })
```

## `testGapsCheck(options?)`

| Option       | Default | Meaning                                                                      |
| ------------ | ------- | ---------------------------------------------------------------------------- |
| `coverage`   | `'run'` | `'run'` runs the tests with coverage; `{ file }` reads an lcov or Go profile |
| `collectors` | —       | `CoverageCollector`s to use instead                                          |
| `top`        | 10      | suggestions reported                                                         |
| `examples`   | 3       | top suggestions that get an agent-written test; 0 disables                   |
| `verify`     | false   | let the agent run the single new test (grants `run`)                         |
| `churnDays`  | 90      | churn window                                                                 |

`coverageCollectors(dir, coverage?)` returns the collectors `testGapsCheck` would use (one per language with its primary framework, or a reader of `{ file }`); `collectCoverage(collectors, { dir, runner, signal? })` runs them one after another, skips failing ones and merges the reports, with `tools` naming the collectors that produced one. The `coverage` analyzer (`@holtkeeper/coverage`) builds on both.

`detect` is true when a test framework is found or a coverage file is given. `run` returns `tests` (`TestSuggestion[]`), `coverage` (line and function summary) and `changes`. It throws when no collector produced a report.

## Steps

1. **Detection** — `detectTestSetup(dir)` reads `package.json` dependencies and test scripts, config files (`vitest.config.*`, `jest.config.*`, `.mocharc*`, `bunfig.toml [test]`, `pytest.ini`, `conftest.py`, `pyproject.toml`/`setup.cfg`/`tox.ini` sections, `go.mod`) and the imports of existing tests. Frameworks: `bun:test`, `vitest`, `jest`, `mocha`, `node:test`, `go test`, `pytest`, ranked by evidence; imports weigh most. Per language it learns `TestConventions`: layout (`colocated`, `__tests__`, `test-dir`), file name template, the usual framework import and the local import extension, and picks up to three sample tests (mid-sized, from different folders, using the primary framework).
2. **Coverage** — one `CoverageCollector` per language, run through the `CommandRunner` in `.holtkeeper/coverage-*` (removed afterwards). Failing tests are fine as long as a report is written.

   | Framework   | Command                                                                 |
   | ----------- | ----------------------------------------------------------------------- |
   | `bun:test`  | `bun test --coverage --coverage-reporter=lcov --coverage-dir=…`         |
   | `vitest`    | `<exec> vitest run --coverage.enabled --coverage.reporter=lcov …`       |
   | `jest`      | `<exec> jest --coverage --coverageReporters=lcov --coverageDirectory=…` |
   | `mocha`     | `<exec> c8 --reporter=lcov --reports-dir=… mocha`                       |
   | `node:test` | `node --test --experimental-test-coverage --test-reporter=lcov …`       |
   | `pytest`    | `python3 -m pytest --cov=. --cov-report=lcov:…` (needs pytest-cov)      |
   | `go test`   | `go test ./... -coverprofile=…`, then `go tool cover -func=…`           |

   `<exec>` puts `node_modules/.bin` first on `PATH` when it exists (yarn berry's `yarn <bin>` only finds binaries the root workspace declares), else it is `pnpm exec`, `yarn` or `npx --no-install` by lockfile; nothing is installed. A report the tool wrote below its own root (jest resolves `--coverageDirectory` against `rootDir`) is found by the scratch folder's name and removed too. Parsers are pure: `parseLcov` (`SF`, `DA`, `FN` incl. lcov 2 end lines, `FNDA`, `BRDA`, `LF/LH/FNF/FNH`; paths made relative), `parseGoCoverProfile` (blocks spread over lines; summary counts statements like `go test -cover`), `parseGoCoverFunc`.

3. **Ranking** — `rankTestTargets` scans source with a lightweight scanner (`findFunctions`: top-level functions, arrow constants and class methods for JS/TS; functions and methods for Go; functions and methods for Python) and measures each function against the report. Files the tests never loaded count as uncovered. Skipped: test files, `*.d.ts`, configs, generated files (by name or a `DO NOT EDIT`/`@generated` header), type-only modules, functions under 3 lines or at 50% coverage and above. Score: `uncovered share × (log2(1 + lines) + 1 + branches) × (1 + log2(1 + churn))`; branches come from `BRDA` when present, else from decision points in the source. Churn is the commit count per file from `git log --since=<days>.days --name-only --relative` (empty outside git). Reasons read like `No test covers createSession; 42 lines, 3 branches, changed 7 times in 90 days`.
4. **Examples** — with `context.agent`, `writeExampleTests` asks for one test file per top suggestion (`read` + `search`, plus `run` with `verify`). The prompt names the target, reason, framework, import style, samples and the conventional path (`testPathFor`). The answer must match `{ path, content, notes }`; the path must satisfy `testPathProblem` (framework naming, layout, inside the project) and must not exist. Accepted answers become a `create` `CodeChange` (`confidence: 'review'`, `source`: the agent's name) linked via `changeId`/`testFile`. A file the agent wrote only to verify is removed. Failures per target are skipped; without an agent, suggestions carry no change.

## Limitations

- The function scanner is heuristic: nested functions, object-literal methods and exotic syntax are not reported.
- Only the primary framework per language is run. Monorepos whose packages use different runners get the root runner only.
- Branch counts from Go come from the source; Go profiles have no branch data.
