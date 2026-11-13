# @holtkeeper/quality-tests

Test framework detection and coverage collection for a checkout, the building blocks of the `coverage` analyzer (`@holtkeeper/coverage`); the `testids` analyzer uses its file listing.

```ts
import { collectCoverage, coverageCollectors } from '@holtkeeper/quality-tests'

const report = await collectCoverage(await coverageCollectors(dir), { dir, runner })
```

## API

- `coverageCollectors(dir, coverage = 'run', options?)` — one `CoverageCollector` per language with its primary framework, or a reader of `{ file }` (an lcov tracefile or Go cover profile) when given. `options.go` (`GoCoverageOptions { testTimeout?, tags?, timeoutMs? }`) tunes the Go collector; `goCoverageCollector(options)` builds it directly and `goTestEnv` is its environment.
- `collectCoverage(collectors, { dir, runner, signal?, log? })` — runs them one after another, skips failing ones and merges the reports (`CoverageReport { format, languages, files, summary, notRun? }`), with `tools` naming the collectors that produced one. Throws only when none did, with every collector's error.
- `detectTestSetup(dir)`, `frameworkFor(setup, language)` — the detected frameworks and test conventions.
- File helpers: `listFiles`, `languageOf`, `isTestFile`, `isExcludedByName`, `isComponentFile`, `isGeneratedSource`; source helpers: `codeLines`, `isTypeOnlySource`, `findFunctions`.
- Pure parsers: `parseLcov`, `parseGoCoverProfile`, `parseGoCoverFunc`, `goPackageDir`, `parseGoTestEvents` (`go test -json` stdout: packages that ran, failed, had no test files or did not run, with the reason and Go's first error line).
- Go build constraints: `goBuildConstraint(source)`, `evalGoBuildConstraint(expression, isSet)` and `goTaggedTests(files, tags)`, the test files a linux/amd64 run with `tags` leaves out only because of custom tags, counted per tag.

## Steps

1. **Detection** — `detectTestSetup(dir)` reads `package.json` dependencies and test scripts, config files (`vitest.config.*`, `jest.config.*`, `.mocharc*`, `bunfig.toml [test]`, `pytest.ini`, `conftest.py`, `pyproject.toml`/`setup.cfg`/`tox.ini` sections, `go.mod`) and the imports of existing tests. Frameworks: `bun:test`, `vitest`, `jest`, `mocha`, `node:test`, `go test`, `pytest`, ranked by evidence; imports weigh most. Per language it learns `TestConventions`: layout (`colocated`, `__tests__`, `test-dir`), file name template, the usual framework import and the local import extension, and picks up to three sample tests (mid-sized, from different folders, using the primary framework).
2. **Coverage** — one `CoverageCollector` per language, run through the `CommandRunner` in `.holtkeeper/coverage-*` (removed afterwards). Failing tests are fine as long as a report is written. Go is stricter:
   - It runs once per module that `discoverGoModules` (`@holtkeeper/go-source`) finds, up to four folders deep with `GOWORK=off`, or once at the root over every member of a root `go.work`. The env is `GOTOOLCHAIN=local` and, per module, `GOFLAGS=-mod=mod` (Go refuses `-mod=mod` in workspace mode, so the `go.work` run leaves it out), and Go's `-timeout` defaults to `5m`.
   - `go test` writes a zero-count profile even when no package's tests could run. So a module whose run exited non-zero without a single package running counts as failed. When every module failed, the collector throws with Go's output. Otherwise the failed modules go to `notRun` with `recursive`, and `except` lists the nested modules inside them that ran on their own.
   - Results come from `-json` events. Cached runs count as run, and packages without test files count as having no tests. Packages that did not build (`FailedBuild`, `[build failed]`), could not load dependencies (`[setup failed]`) or hit `-timeout` go to `notRun` with their folder and to `log`, and so do packages with failing tests.
   - Before running, `_test.go` files that need build tags the run does not set are counted per tag and logged.
   - With `tags`, a second run per module adds `-tags=…`. Its profile is appended to the first, and `parseGoCoverProfile` keeps the highest count per statement. Its failures are only logged, and packages that ran there are dropped from `notRun`.

   | Framework   | Command                                                                         |
   | ----------- | ------------------------------------------------------------------------------- |
   | `bun:test`  | `bun test --coverage --coverage-reporter=lcov --coverage-dir=…`                 |
   | `vitest`    | `<exec> vitest run --coverage.enabled --coverage.reporter=lcov …`               |
   | `jest`      | `<exec> jest --coverage --coverageReporters=lcov --coverageDirectory=…`         |
   | `mocha`     | `<exec> c8 --reporter=lcov --reports-dir=… mocha`                               |
   | `node:test` | `node --test --experimental-test-coverage --test-reporter=lcov …`               |
   | `pytest`    | `python3 -m pytest --cov=. --cov-report=lcov:…` (needs pytest-cov)              |
   | `go test`   | `go test -json -timeout=5m -coverprofile=… ./...`, then `go tool cover -func=…` |

   `<exec>` puts `node_modules/.bin` first on `PATH` when it exists (yarn berry's `yarn <bin>` only finds binaries the root workspace declares), else it is `pnpm exec`, `yarn` or `npx --no-install` by lockfile; nothing is installed. A report the tool wrote below its own root (jest resolves `--coverageDirectory` against `rootDir`) is found by the scratch folder's name and removed too. Parsers are pure: `parseLcov` (`SF`, `DA`, `FN` incl. lcov 2 end lines, `FNDA`, `BRDA`, `LF/LH/FNF/FNH`; paths made relative), `parseGoCoverProfile` (blocks spread over lines; summary counts statements like `go test -cover`), `parseGoCoverFunc`.

## Limitations

- Only the primary framework per language is run. Monorepos whose packages use different runners get the root runner only.
- Go profiles have no branch data.
- Without `tags`, tests behind `//go:build integration` (or any other custom tag) are not compiled; the log names how many and which tags. CI-written profiles can still be read with `{ file }`.
