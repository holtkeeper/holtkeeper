# @holtkeeper/quality

Code quality as one analysis built from independent checks. Each check finds something different; this package defines what they report, merges their results and renders the report (`quality` analysis kind).

## Checks

| Package                                                           | Check         | Finds                                                                                                                                              |
| ----------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`quality-conventions`](../../quality-conventions/docs/README.md) | `conventions` | The naming style each kind of name follows in this project (constants, functions, types, files, ...) and the names that break it, with renames     |
| [`quality-tests`](../../quality-tests/docs/README.md)             | `tests`       | Untested or barely tested code from coverage, ranked by size, complexity and churn; example tests written by the agent in the project's test style |
| [`quality-lint`](../../quality-lint/docs/README.md)               | `lint`        | Findings and autofixes of the linters the project already uses, through SARIF                                                                      |
| [`quality-duplication`](../../quality-duplication/docs/README.md) | `duplication` | Copy-pasted code (jscpd)                                                                                                                           |

A check implements `QualityCheck { name; detect(dir); run(context) }` and returns any of `issues`, `tests`, `conventions`, `coverage`, `duplication` and `changes`. `context` has the directory, a `CommandRunner` and, when an LLM is configured, an `Agent`.

## Running

```ts
const data = await analyzeQuality({
  dir,
  checks: [conventionsCheck(), testGapsCheck(), lintCheck(), duplicationCheck()],
  agent,
})
```

Checks that do not detect themselves are skipped; a failing check is recorded in `tools` and the others continue. Changes are de-duplicated by id. `qualityDataSchema` validates uploads; `stableId(...parts)` gives issues and changes ids that survive re-runs.

## Report

Metrics: issues, errors, line coverage, places worth testing, naming consistency, duplicated lines, suggested changes — with deltas against the previous run. Sections: naming conventions (table, outliers, renames), tests (ranked targets, suggested tests), one section per finding category with fixes, and the tools that ran. Suggested changes appear as `changes` blocks that can be accepted.
