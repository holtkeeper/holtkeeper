# @holtkeeper/release-risk

Scores how risky a release is from analyses Holtkeeper already stored — changelog, bundle sizes, quality, dependency graph and vulnerability audits — and writes a plain-language summary for QA and managers. It runs no tools itself and needs no checkout.

## Analyzer

`releaseRiskAnalyzer` — kind `release-risk`, scope `repo`, needs `history`, agent `optional`, `after` `changelog`, `bundle`, `quality`, `depgraph` and `audit`: the queue starts it only once those jobs of its repository queued before it have ended. Assessing a given ref, it is recorded at the time of that ref's changelog record, so past releases sort by release date.

Options (zod `releaseRiskOptions`):

- `weights` — partial `RiskWeights`, the most points each factor may add (numbers are coerced).
- `summary` — `auto` (default: the agent writes it when one is configured) or `changelog` (always deterministic). Flag `--summary`.

The release is `context.ref`, or the `to` of the newest changelog record when absent. Inputs, loaded by `loadRiskInputs(history, repo, ref?)` for the same repository:

| Input                          | Record                                                                       |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `changelog`                    | `changelog` record with that ref (the newest when no ref is given)           |
| `bundle`, `previousBundle`     | `bundle` record with that ref, and the newest older one with a different ref |
| `quality`, `previousQuality`   | `quality` record with that ref, else the newest; and the one before it       |
| `depgraph`, `previousDepgraph` | same rule for `depgraph`                                                     |
| `audit`, `previousAudit`       | the two newest audit runs                                                    |

Records are read through tolerant zod views (`changelogView`, `bundleView`, `qualityView`, `depgraphView`) that keep only the fields used, so this package does not depend on the analysis packages. A record that fails its view is reported in `missing` with the reason.

## Scoring

`assessRisk(inputs, weights?) → RiskAssessment` is pure and deterministic. Each factor turns a fraction `0..1` into `round(weight × fraction)` points; the score is the sum, capped at 100.

| Factor            | Default weight | Fraction                                                                                     |
| ----------------- | -------------: | -------------------------------------------------------------------------------------------- |
| `vulnerabilities` |             25 | `critical + 0.4 × high`, counting findings not in the previous audit (all, without one)      |
| `breaking`        |             20 | `0.5 × breaking + 0.2 × reverts` (merges ignored)                                            |
| `size`            |             15 | `0.3·s(commits, 40) + 0.4·s(lines, 2000) + 0.3·s(files, 80)`, `s(x, h) = x / (x + h)`        |
| `bundle`          |             15 | JS+CSS gzip growth / 10% `+ 0.25 ×` new packages of ≥ 10 kB gzip; shrinking scores 0         |
| `untested`        |             15 | changed files with test gaps / 5; without changed paths, `0.5 × (0.8 − line coverage) / 0.8` |
| `dependencies`    |             10 | `0.4 × new cycles + 0.1 × new duplicated libraries` against the previous graph               |
| `quality`         |             10 | `new errors / 10 + new warnings / 100`, issues matched by their stable id                    |
| `contributors`    |             10 | `0.7·s(authors − 1, 6) + 0.3 × min(1, hotspots / 3)`; a hotspot is a scope with ≥ 5 commits  |

Levels: `low` < 25 ≤ `medium` < 50 ≤ `high` < 75 ≤ `critical`.

A factor whose inputs are missing is `known: false`, scores 0 and says why. Factors that need a comparison (`bundle`, `dependencies`, `quality`) are unknown without the earlier record. `confidence` is the sum of input shares: changelog 0.3, audit 0.2, bundle/quality/depgraph 0.1 each, every "previous" input 0.05.

Each `RiskFactor` is `{ id, label, points, max, detail, tone, known, evidence }`; `evidence` links to the underlying records (`/analyses/<id>`, audit runs to `/audits`), commits (when the changelog has link templates), advisories and quality rule docs.

`testAreas(inputs)` — "what to test": user-facing changes (feat, fix, perf, refactor, revert, breaking and non-conventional commits) grouped by scope (`General` without one), riskiest first, then changed files with untested code. At most 15.

## Summary

`summarizeRelease(assessment, changelog, { agent?, dir?, signal?, log? }) → RiskSummary`.

- With an agent: one `agent.run` with `read`/`search` capabilities only, structured output `agentSummarySchema` (`overview`, `changes`, `test`, `risks`), rendered by `renderAgentSummary`. The agent works in the checkout when the analyzer has one, otherwise in an empty temporary directory that is removed afterwards. A failure is logged and falls back to the deterministic summary; aborts propagate.
- Without one: `deterministicSummary` — headline with level, score and confidence, user changes by group (`userChanges`: Breaking, New, Fixed, Faster, Reverted), what to test, and the factors that scored.

## Data

```ts
interface ReleaseRiskData {
  ref?: string
  score: number // 0..100
  level: 'low' | 'medium' | 'high' | 'critical'
  confidence: number // 0..1
  factors: RiskFactor[]
  missing: { input: InputName; reason: string }[]
  testAreas: TestArea[]
  summary: { source: 'agent' | 'changelog'; agent?: string; markdown: string }
  sources: { id; kind; ref?; createdAt; href }[] // href: /analyses/<id> or /audits
}
```

`releaseRiskDataSchema` validates uploads.

## Report

`releaseRiskAnalysis` (kind `release-risk`, label `Release risk`) and `releaseRiskReport(data, { previous? })`.

Metrics: risk score (tone by level, `better: 'down'`), level, confidence (percent), number of scoring factors — with deltas against the previous assessment.

Sections:

1. **Summary** — the markdown summary; says which agent wrote it.
2. **Risk factors** — issues for factors that scored, most points first, and a table of every factor with points (or `unknown`), weight, change since the previous assessment, reason and first evidence link.
3. **What to test** — test areas as issues, tagged with commit counts.
4. **Underlying analyses** — linked source records and the missing inputs.

## Limitations

- Changelog data has no list of changed paths yet; `untested` reads an optional `files: string[]` from the changelog record and otherwise falls back to overall coverage.
- Bundle growth needs bundle records stored with release refs; other inputs use the newest records, which may describe a later commit than the release.
- Audit runs have no per-run page, so their evidence links to `/audits`.
