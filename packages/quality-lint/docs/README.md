# @holtkeeper/quality-lint

The `lint` quality check: runs the linters a project already configures, reads their reports through SARIF (or ESLint JSON) and turns them into `QualityIssue`s and, where the linter proposes a fix, `CodeChange`s with exact `replace` edits.

## Public API

- `lintCheck({ adapters?, only?, timeoutMs? }): QualityCheck` — check named `lint`. `detect(dir)` is true when any adapter detects itself. `run` goes through the adapters one after another; for each detected one it runs the version command (a failure to start or a non-zero exit means "not installed", and the adapter is skipped), then the lint command in `dir` through the context's `CommandRunner`. `version` lists every tool that ran, e.g. `oxlint 1.90.0, ruff 0.9.1`. A linter that fails (bad exit code, unparsable output) is marked `(failed: ...)` in `version` and the rest still count; the check throws only when every linter that ran failed. `only` restricts the run to adapter names.
- `defaultAdapters()` and the adapters below; `LinterAdapter`, the contract.
- `parseSarif(log, { dir, tool?, files?, isSafeFix? }): Promise<LintFindings>` — SARIF 2.1.0 to `{ issues, changes }`.
- `parseEslintJson(report, { dir, files? }): Promise<LintFindings>` — ESLint `json` / `json-with-metadata` to `{ issues, changes }`.
- `categorize(ruleId, hints)` — the category heuristic; `sourceReader(dir, files?)` — cached file reader both parsers take.

## Supported linters

| Adapter                 | Runs when                                                                         | Command                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `oxlintAdapter()`       | `.oxlintrc.json`, `.oxlintrc.jsonc`, `oxlint.config.ts` or an `oxlint` dep        | `oxlint -f sarif`                                                                                      |
| `eslintAdapter()`       | `eslint.config.*`, `.eslintrc*`, or `eslintConfig` in `package.json`              | `eslint --format @microsoft/eslint-formatter-sarif .` if installed, else `--format json-with-metadata` |
| `biomeAdapter()`        | `biome.json`, `biome.jsonc` or a `@biomejs/biome` dep                             | `biome lint --reporter=sarif --max-diagnostics=none --colors=off`                                      |
| `golangciLintAdapter()` | `.golangci.yml`, `.yaml`, `.toml`, `.json`                                        | `golangci-lint run --output.sarif.path=stdout --show-stats=false` (v2 flags)                           |
| `ruffAdapter()`         | `ruff.toml`, `.ruff.toml` or `[tool.ruff]` in `pyproject.toml`                    | `ruff check --output-format sarif --no-cache`                                                          |
| `semgrepAdapter()`      | `.semgrep.yml`, `.semgrep.yaml` or `.semgrep/`; any project with `{ auto: true }` | `semgrep scan --sarif --quiet --config <that> --metrics=off`, or `--config auto`                       |
| `astGrepAdapter()`      | `sgconfig.yml` / `sgconfig.yaml`                                                  | `ast-grep scan --format sarif`                                                                         |

JavaScript tools use the project's `node_modules/.bin` copy when it exists, ruff its `.venv/bin` copy; otherwise the binary comes from `PATH`. Exit codes 0 and 1 are a completed run (linters exit 1 when they found something).

Notes per tool:

- **oxlint** — its SARIF has no fixes today; when it emits them, a rule whose `properties.fix` is `fixable_fix` gives `safe` changes, suggestions and dangerous fixes `review`.
- **ESLint** — `eslintAdapter({ format: 'json' })` forces the JSON path, which keeps autofixes (`safe`) and suggestions (`review`); the Microsoft SARIF formatter drops them. `json-with-metadata` supplies rule docs URLs and `meta.type` (`layout` → `style`).
- **Semgrep** — the LGPL CLI is called as an external binary, nothing is linked. `--config auto` downloads registry rules and requires metrics, so it is opt-in.
- **ast-grep** — called as `ast-grep`, because `sg` is a different program on many Linux systems.

## SARIF mapping

- `ruleId` (or `rule.id`, or the rule at `ruleIndex`) → `rule`; `level` (or the rule's `defaultConfiguration.level`, else `warning`): `error` → `error`, `warning` → `warning`, `note`/`none` → `info`.
- Message: `message.text`, else the rule's `messageStrings[message.id]` with `{0}` arguments filled in.
- First physical location → `file` (relative to `dir`; `file:` URIs, `uriBaseId`s and canonical paths such as macOS `/private/var` are resolved) and `range` (1-based, end-exclusive, UTF-16 columns as `@holtkeeper/changes` expects). `charOffset`/`charLength` regions and `unicodeCodePoints` columns (the SARIF default) are converted with the file text. A region without columns spans whole lines.
- `help.text` / `fullDescription` / `shortDescription` → `help`; `helpUri` → `url`.
- Category from the rule id plus `properties.tags` and `properties.category`: security (`security`, CWE tags, `security-severity`, gosec, bandit `S###`), then complexity (`complexity`, `max-depth`, `gocyclo`, ruff `C90#`, ...), then style (`style`, `format`, `naming`, `layout`, gofmt, ...), else `lint`.
- Suppressed results and `pass` / `notApplicable` results are skipped.
- `id = stableId(tool, rule, file, offending text)`, so it survives code moving around.
- `fixes[].artifactChanges[].replacements` → one `CodeChange` per fix, `replace` edits with `oldText` read from the file. A fix whose region cannot be located is dropped; the issue stays. `confidence` is `safe` only when the tool says so (`isSafeFix`, default: `properties.safe === true` or `properties.applicability === 'safe'` on the fix); the issue's `changeId` points at the first fix.

## Adding a linter

1. Add `src/adapters/<tool>.ts` exporting a factory that returns a `LinterAdapter`:
   - `detect(dir)` — config files or dependencies only (`hasAny`, `hasDependency`, `fileContains` from `src/detect.ts`); never run anything.
   - `command(dir)` — the argv printing a report to stdout; use `projectBinary` for tools projects pin locally.
   - `parse(stdout, dir)` — usually `parseSarif(stdout, { dir, tool })`, with `isSafeFix` if the tool marks safe fixes its own way. Write a converter like `parseEslintJson` when the tool has no SARIF.
   - Optional `versionCommand(dir)` (default `<binary> --version`) and `okExitCodes` (default `[0, 1]`).
2. Add it to `defaultAdapters()` in `src/adapters/index.ts` and to the table above.
3. Test detection and the command in `src/adapters/adapters.test.ts`; test parsing against a real captured report.
