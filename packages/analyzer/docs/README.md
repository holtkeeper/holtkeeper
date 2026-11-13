# @holtkeeper/analyzer

The contract between analyzers and the runner that runs them (the task engine of `@holtkeeper/jobs`). An `Analyzer` declares its kind, scope (`repo` or `group`), options schema and what it `needs` (checkout, forge, agent, history); runners provide exactly that in an `AnalyzerContext` (plus `jobId`, the id of the job inside the task engine) and store what `run` returns. `run` returns `{ data, ref?, sha?, at?, artifacts? }`: `sha` is the commit the data describes; runners fall back to the commit of the job's checkout, so analyzers without one set it to the forge head they read.

`keepRecords: n` makes runners delete the analyzer's older records of a repository after storing a new one, keeping the newest `n`; for snapshot analyzers whose history lives elsewhere (`ci-jobs` keeps 3).

`pool: '<name>'` puts the analyzer's jobs in a worker pool: only workers started for that pool claim them (`DEFAULT_POOL`, `default`, is the pool of analyzers that name none). The `write-task` analyzer uses `write`, so code-changing agents run only on dedicated workers.

`defaultBranchOnly: true` marks an analyzer whose run reads only the default branch and rejects a `ref`; event triggers and merge request policies, whose jobs carry one, leave it out instead of queuing a job bound to fail.

## Metrics

The metrics functions wrap `AnalysisKind.metrics` (see [`@holtkeeper/report`](../../report/docs/README.md)) for both places that store records, the task engine's worker and the server's upload route:

- `analysisMetrics(kind, data, context?)` — the kind's metrics of `data` as plain JSON (`undefined` fields dropped). `undefined` for an unknown kind, a kind without metrics, data that fails the kind's schema (a shape an older release wrote) or a kind that throws; never throws.
- `recordMetrics(analyses, kind, { repo, ref?, createdAt?, data }, options?)` — the metrics to store with a new record. It looks up the previous record on the same line of history, the newest one created before `createdAt`: one with the same ref, falling back to one without a ref (the default branch) when a record with a ref has no earlier record on its ref (runs on other branches are left out); and passes its stored metrics (or metrics computed from its data when it has none) as `previous`, and `createdAt` when given. Never throws.
- `metricsOf(kind, record)` — a record's stored metrics typed as the kind defines them; `undefined` for records of another kind or without metrics.

## Freshness

`refresh?: AnalyzerRefresh` says when the server's freshness sweeper queues the analyzer on its own:

- `{ on: 'change', minInterval, paths?, heavy? }`: the default branch moved past the commit (`sha`) of the latest record, at most once per `minInterval` (`30m`, `6h`, `7d`, ...). With `paths` (globs from the repository root, e.g. `dependencyPaths`: every JavaScript and Go manifest and lockfile) only changes to matching files count.
- `{ on: 'time', cadence, heavy? }`: the data changes without commits (advisories, registries, end-of-life dates, CI history), so it reruns once `cadence` passed since the latest record. Group analyzers use this, having no commit of their own.
- `heavy: true` holds runs to the night window.

Without `refresh` the analyzer never runs automatically: only on events, schedules people create and demand (merge request review, write tasks). Analyzers that may call an LLM (`needs.agent`) are only refreshed from records that name a commit and within the weekly budget for automatic work; keep their `minInterval` at a day or more.

Analyzers without a checkout report the commit they read: `defaultBranchHead(forge, repo)` reads the default-branch head (`GitForge.headCommit`, else the newest commit of the default branch; `undefined` on failure), and `withDefaultBranchHead(analyzer)` wraps an analyzer so a default-branch run without its own `sha` records the head read before the run.

## Applicability

`appliesTo?: Applicability` says whether a repository uses what the analyzer works on. Schedules and freshness ask it before queueing a repository job, so an analyzer in a schedule over every group runs only where it has something to do, and repositories that start or stop using it join or leave on the next run. It reads the default branch through the forge (`ApplicabilityContext`: `repo`, `forge.readFile`), never a checkout, so keep it to a few small files. A check that throws counts as applying; manual runs skip the check, so `run` must still handle a repository it does not apply to.

Building blocks, combinable:

| Check                             | Applies when                                                                                                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hasFile(...paths)`               | any of the files exists                                                                                                                                                                                 |
| `fileContains(paths, text \| re)` | any of the files contains the text or matches the expression                                                                                                                                            |
| `lockfileHasPackage(name)`        | a root JavaScript lockfile (`jsLockfiles`: bun, pnpm, yarn, npm) resolves the package                                                                                                                   |
| `hasTreeFile(matches)`            | a file in the tree satisfies `matches`, outside `node_modules/`, `vendor/`, `testdata/` and hidden folders; also applies when the forge cannot list the tree or the listing hits its 10 000-entry limit |
| `anyOf(...checks)`, `allOf(...)`  | any / every check applies, evaluated in order and stopping early                                                                                                                                        |

```ts
defineAnalyzer({
  kind: 'browserslist',
  appliesTo: lockfileHasPackage('caniuse-lite'),
  // ...
})
```

## Optional needs

`forge`, `forgeAccess` and `history` take `true` (the runner must provide it) or `'optional'` (provided when the runner can, and `run` copes without it). The task engine provides all three; for `'optional'` forge access it skips a forge that gives no token instead of failing the job.

## Forge access

`needs.forgeAccess` gives `context.forgeAccess` (`ForgeAccess`): the forge's `kind`, base `url` and API `token`, its `fetch` with the per-token rate limits (send the tool's API calls through it), the forge's SSH signing key with its identity when it has one, and `readOnly` for repositories Holtkeeper must not change. It is for analyzers that hand the forge to an external tool, such as [@holtkeeper/renovate](../../renovate/docs/README.md); everything else uses `context.forge`. Pass the token to the tool through its environment, never in files or logs, and push nothing when `readOnly` is set.

`context.step(name, run)`, present when the task engine runs the analyzer, marks a part of the run as a named step of the job's log: start and end with the duration, the lines logged meanwhile belong to it, and a step that throws becomes the attempt's failing step (the error is rethrown). Call `run` directly when it is absent.

## Panel editor

`editor` names a dedicated panel editor for the analyzer's `analyzers.<kind>` setting (`renovate`), instead of the form generated from `options`.
