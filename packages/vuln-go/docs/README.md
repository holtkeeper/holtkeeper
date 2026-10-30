# @holtkeeper/vuln-go

A `Fixer` for Go modules. Given findings for a `go.mod`, it upgrades the vulnerable modules with `go get` and tidies the module.

## Public API

- `goFixer(options?: { runner?: CommandRunner }): Fixer` — fixer named `go`. `supports(source)` is true for any file named `go.mod`. Commands run through `runner` (default: `localRunner` from `@holtkeeper/exec`).
- `planGoUpgrades(findings): GoUpgradePlan` — pure planning step: findings in, `{ upgrades, notes }` out.

## Planning rules

- Only findings with ecosystem `Go` are handled; others are skipped with a note.
- The target for a finding is `fixedVersions[0]`. Without one, the finding is skipped with a note.
- Several findings for one module are merged into one upgrade to the highest target; all their ids count as fixed once `go get` succeeds.
- A target at or below the version in use is never applied (no downgrades).
- Versions are accepted with or without `v` (osv-scanner reports `0.3.0`); `go get` always gets `v0.3.8`.
- `stdlib` and `toolchain` findings change nothing. They produce one note per pseudo-package, such as `stdlib: upgrade the Go toolchain to go1.22.7 or later (GO-...)`.

## Commands

In the directory of the `go.mod`:

1. `go get <module>@v<version>` for each planned upgrade, one at a time. A failure becomes a note and the module is not reported as fixed.
2. `go mod tidy`, only if at least one `go get` succeeded. A failure throws `CommandError`.

`changedFiles` lists `go.mod` and `go.sum` (relative to the project) when their contents changed.

## Environment

- `GOTOOLCHAIN=local` — never download a toolchain. If a new dependency version needs a newer Go than the one installed, `go get` fails and the failure is reported as a note.
- `GOWORK=off` — ignore any `go.work` above the module.
- `GOFLAGS=-mod=mod` — allow updating `go.mod` even when a `vendor/` directory exists. This replaces any `GOFLAGS` from the caller's environment.

`GOPROXY`, `GOPRIVATE` and credentials come from the caller's environment.

## Limitations

- Standard library and toolchain advisories need a Go upgrade, which this fixer does not do. osv-scanner 2.7 did not report `stdlib` findings for `go.mod` sources in our tests, but other scanners (and older osv-scanner versions) do.
- `go get` may raise the `go` directive or upgrade other modules when the new version requires it.
- `replace` directives win over `require`: if the vulnerable module is replaced, `go get` updates `require` but the build still uses the replacement. Such findings will reappear on rescan.
- Workspaces (`go.work`) are not updated; each module is fixed on its own with `GOWORK=off`.
- `vendor/` directories are not refreshed (`go mod vendor` is not run).
