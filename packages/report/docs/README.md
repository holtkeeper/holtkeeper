# @holtkeeper/report

The universal output of every analysis. Each analyzer keeps its own data shape; an `AnalysisKind` turns that data into a `Report`, and clients render any report from a fixed set of blocks without knowing which analysis produced it.

## Report

```ts
interface Report {
  kind: string // 'changelog', 'bundle', 'depgraph', ...
  title: string
  subtitle?: string
  subject?: { repo?: RepoRef; ref?: string; compareTo?: string }
  generatedAt: string
  metrics: Metric[] // headline numbers
  sections: { id; title; description?; blocks: Block[] }[]
}
```

`Report.exclude` (`ReportExclude { setting, options: { option, label, description? }[] }`) says that files of the report can be left out of later runs by adding globs to a list option of an analyzer setting, e.g. `analyzers.assets` → `optimizeIgnore` or `ignore`; renderers offer it on cells of `path` columns.

`Metric` has a `value`, a `unit` (`count`, `bytes`, `percent`, `ms`, `version`, `text`), an optional `delta` against the compared report, and `better: 'up' | 'down'` so renderers know whether growth is good (more fixes) or bad (bigger bundle).

## Blocks

| Block      | For                                                                                                                                                                                                                                                                                                                  |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `metrics`  | A row of metric cards inside a section                                                                                                                                                                                                                                                                               |
| `table`    | Columns with units, delta, tag and `sparkline` formats, sortable rows, optional `groupBy`; cells can be links with a tone, a sort `value` and a `series` drawn as a sparkline; `path` columns hold repository-relative file paths                                                                                    |
| `chart`    | `bar`, `stacked-bar`, `line`, `area`, `donut` or `combo` over `data` with named `series`; `combo` draws each series as a bar, line or area on the left or right axis (`rightUnit`). Line, area and combo charts take shaded `bands` between two keys (e.g. p25–p75) and vertical `markers`; `null` values leave gaps |
| `heatmap`  | Rows by columns of colored cells (`xLabels`, `yRows`), e.g. jobs by week; a `sequential` scale fills one tone, a `diverging` one colors by the direction `better` prefers                                                                                                                                            |
| `treemap`  | Nested sizes, e.g. bundle composition by package                                                                                                                                                                                                                                                                     |
| `timeline` | Dated items with links and tags; `children` collapse duplicates such as identical commit messages                                                                                                                                                                                                                    |
| `graph`    | Nodes and edges; `highlight` paths emphasize problems such as dependency cycles                                                                                                                                                                                                                                      |
| `issues`   | Callouts with a tone: problems, warnings, notable changes                                                                                                                                                                                                                                                            |
| `markdown` | Free text, rendered without raw HTML                                                                                                                                                                                                                                                                                 |

`Tone` (`neutral`, `info`, `good`, `warning`, `bad`) carries meaning; renderers map it to the theme. Adding a block type means adding it to the union here and one renderer in the web UI.

## AnalysisKind

```ts
interface AnalysisKind<Data> {
  kind: string
  label: string
  schema: z.ZodType<Data> // validates uploads
  summarize(data: Data): Metric[] // for lists and trends
  toReport(current: AnalysisRecord<Data>, previous?: AnalysisRecord<Data>): Report
}
```

The server stores records (`AnalysisRecord`: repo, kind, ref, time, data), validates uploads with `schema`, and renders `toReport` on request — comparing with the previous record of the same repository and kind, or any record the client picks. Reports are rendered when requested rather than stored, so improving a report improves it for all history.

Kinds: [`changelog`](../../changelog/docs/README.md), [`bundle`](../../bundles/docs/README.md), [`depgraph`](../../depgraph/docs/README.md), [`ci-jobs`](../../ci-jobs/docs/README.md).

## Helpers

`metric(id, label, value, { unit, previous, better })` builds a metric with its delta; `formatBytes`, `formatRef` (full commit SHAs as short ones) and `percentChange` keep numbers and refs consistent across reports and clients.
