# Fixtures

Small projects with known-vulnerable dependencies, used by integration tests. They are not workspaces and are never installed by `bun install` at the root.

| Fixture | Ecosystem                 | What it has                                                                                                     |
| ------- | ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `npm/`  | npm (`package-lock.json`) | Pinned `lodash@4.17.15` and `express@4.17.1` with many transitive advisories                                    |
| `go/`   | Go (`go.mod`)             | `golang.org/x/text v0.3.0` (several advisories, first fixes 0.3.3 to 0.41.0); `go 1.27.2` so no stdlib findings |

Tests copy a fixture into a temporary directory before changing anything.
