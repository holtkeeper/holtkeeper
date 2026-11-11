# @holtkeeper/quality

The contract for checks that find problems on a checkout, and the runner that merges their results. The review analyzer runs these checks on changed lines; there is no standalone quality analysis.

## Checks

| Package                                                   | Check     | Finds                                                     |
| --------------------------------------------------------- | --------- | --------------------------------------------------------- |
| [`quality-secrets`](../../quality-secrets/docs/README.md) | `secrets` | Leaked secrets (gitleaks)                                 |
| [`testids`](../../testids/docs/README.md)                 | `testids` | Interactive elements without the project's test attribute |

A check implements `QualityCheck { name; detect(dir); run(context) }` and returns any of `issues` and `changes` (suggested fixes an issue points at through `changeId`). `context` has the directory, a `CommandRunner` and an optional `AbortSignal`.

## Running

```ts
const data = await analyzeQuality({ dir, checks: [secretsCheck(), testIdsCheck()], runner })
```

Checks run one after another. Checks that do not detect themselves are skipped; a failing check is recorded in `tools` and the others continue. A check that applies but had nothing to run returns `skipped: reason`, kept in `tools`. Changes are de-duplicated by id. `stableId(...parts)` gives issues and changes ids that survive re-runs.
