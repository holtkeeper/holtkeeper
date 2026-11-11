# Fixtures

Small projects used by integration tests: some with known-vulnerable dependencies, one with the signals the Guide generator reads. They are not workspaces and are never installed by `bun install` at the root.

| Fixture    | Ecosystem                          | What it has                                                                                                                                            |
| ---------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm/`     | npm (`package-lock.json`)          | Pinned `lodash@4.17.15` and `express@4.17.1` with many transitive advisories                                                                           |
| `go/`      | Go (`go.mod`)                      | `golang.org/x/text v0.3.0` (several advisories, first fixes 0.3.3 to 0.41.0); `go 1.27.2` so no stdlib findings                                        |
| `service/` | Go (`go.mod`) and a `web/` package | Made-up widget service with a Makefile, GitLab CI, golangci-lint config, `mise.toml`, docs and one Go test; evidence for `@holtkeeper/guide-generator` |

Tests copy a fixture into a temporary directory before changing anything.
