# @holtkeeper/quality-secrets

The `secrets` quality check: runs [gitleaks](https://github.com/gitleaks/gitleaks) (8.30) over a checkout and reports every leaked credential as a `security` error. The secret itself never reaches an issue.

## Public API

- `secretsCheck({ history?, config?, binary?, timeoutMs? }): QualityCheck` — check named `secrets`.
  - `detect(dir)` is true whenever the gitleaks binary is installed (`Bun.which`, or the file exists when `binary` is an absolute path). Every project can leak secrets.
  - `run` calls, through the context's `CommandRunner`, in `dir`:
    `gitleaks dir --no-banner --no-color --redact --log-level error --exit-code 2 --report-format json --report-path - [--config <config>] .`
    With `history: true` and a `.git` in `dir` it also runs the same command with `git` instead of `dir`, which scans every commit reachable in the checkout (a shallow clone only has its shallow history).
  - `version` is `gitleaks <x.y.z>` from `gitleaks version`.
  - Exit codes 0 (no leaks) and 2 (leaks) are a completed run. gitleaks exits 1 on fatal errors such as a broken config, which is why leaks get their own exit code; anything else throws a `CommandError`.
  - History findings at the same rule, file and line as a working-tree finding are dropped: the tree issue already covers them.
- `parseGitleaksReport(report, { dir }): QualityIssue[]` — gitleaks JSON report to issues.
- `gitleaksReportSchema`, `gitleaksFindingSchema`, `TOOL` (`gitleaks`).

## Configuration

gitleaks itself picks up the repository's `.gitleaks.toml` (rules, allowlists) and `.gitleaksignore` (fingerprints to ignore) from the scanned directory, because the check scans `.` with `cwd = dir`. `config` points at another config file, relative to `dir`; it replaces the lookup of `.gitleaks.toml`.

## Mapping

| gitleaks                        | `QualityIssue`                                                                   |
| ------------------------------- | -------------------------------------------------------------------------------- |
| `RuleID`                        | `rule`                                                                           |
| `Description`                   | `message`, with `(commit <sha12>)` appended for history findings                 |
| `File`                          | `file`, relative to `dir`                                                        |
| `StartLine`..`EndLine`, columns | `range`, 1-based with an exclusive end                                           |
| `Commit`, `Author`, `Date`      | `help`: `Introduced in commit <sha> by <author> on <date>`, plus rotation advice |
| —                               | `category: 'security'`, `severity: 'error'`, `tool: 'gitleaks'`                  |

- `id = stableId('gitleaks', rule, file, fingerprint)`, where the fingerprint (`file:rule:line`, or `commit:file:rule:line` for history) has the checkout path removed, so ids do not depend on where the repository was cloned.
- gitleaks 8.30 reports columns one too large on every line except the first of a file; the parser corrects that. Findings without columns span whole lines.
- `Match`, `Secret` and `Line` are never read. The check also always passes `--redact`, and the report goes to stdout instead of a file, so no clear-text copy is written to disk.

## Tests

- `src/parse.test.ts` parses reports captured from gitleaks 8.30.1 (`test/gitleaks-dir.json`, `test/gitleaks-git.json`).
- `src/check.test.ts` checks the commands and exit codes with a fake runner.
- `test/gitleaks.test.ts` creates a git repository in a temp dir with a fake AWS key and a fake GitHub token (gitleaks' own test patterns, assembled at runtime so this repository does not leak them), runs the real gitleaks with history, and checks that a `.gitleaks.toml` allowlist is respected. It is skipped without `gitleaks` or `git`.
