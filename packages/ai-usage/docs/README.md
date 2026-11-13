# @holtkeeper/ai-usage

Records what LLM agent runs use and cost, and enforces spending budgets. Records live in the store's `aiUsage` part (see [@holtkeeper/store](../../store/docs/README.md)); the server exposes them under `/api/ai/*` (see [the server docs](../../../apps/server/docs/README.md)).

## What is recorded

One `AiUsageRecord` per agent run: when it started, the repository and the config groups it had at that moment, task kind, analyzer, job and analysis ids when known, actor, whether a person started it (`interactive`; automatic work otherwise), what it worked on (`subject`, e.g. `MR !42`, when the caller passes one), provider (credential id or name, or `anthropic`), model, input / output / cache read / cache write tokens, cost and where it came from, duration, turns and the outcome:

- `ok` — the agent returned.
- `error` — the agent threw; the error message is kept, and so are tokens, cost and turns when the error carries them (`usage`, `costUsd`, `turns` properties).
- `denied-budget` — a spend limit stopped the run: a `block` budget refused it before the agent was called (tokens and cost 0), or the run failed with `BudgetExceededError` (a provider refusal or its own cost cap; whatever it used is kept).

Prompts and answers are never recorded.

## Recording runs

- `meteredAgent(agent, { record, budgets?, context, prices?, now?, onRecordError? })` wraps an `Agent`. `context` says who and what the runs are for (`repo` with groups, `actor`, `provider`, `model`, optional `taskKind`, `analyzer`, `jobId`, `analysisId`, `interactive`, `subject`; `interactive` and `subject` are stored on every record); the task's own `taskKind` wins over the context's, `agent` is the fallback. With `budgets` every run is checked first (with the task's `estimateUsd` as the expected cost when it gives one, else the mean of this week's runs of its kind); a denial is recorded and thrown as `BudgetDeniedError` (with the `exceeded` budgets), and an allowed run gets `maxCostUsd` lowered to what the budget has left (`withCostCap`). Results and errors pass through unchanged; a failing `record` is reported to `onRecordError` (default `console.error`) and never replaces them.
- `usageRecorder(store.aiUsage, { prices?, now?, groupsOf?, budgets? })` returns an `onRun(info)` hook for agent wrappers that report `{ repo, taskKind, provider, model, result | error, durationMs }` (plus optional `actor`, `interactive`, `subject`, `analyzer`, `jobId`, `analysisId`, `at`, `transcriptRef`). A `BudgetExceededError` is stored as `denied-budget`.
- `BudgetDeniedError` is a `BudgetExceededError` of `@holtkeeper/agent` (same `name`), so everything that recognizes a spend stop, the job worker included, treats a pre-run refusal the same way.

## Costs

`costUsd` is the provider's reported cost when the agent result has one (`costSource: reported`; the Claude Agent SDK reports it). Otherwise it is computed from the token counts and a price table (`computed`): USD per million input, output, cache read and cache write tokens. `defaultPrices` holds Anthropic list prices as of 2026-10 with cache writes at the 5-minute rate; a model id matches its exact entry or the longest entry it contains (`anthropic.claude-opus-5-5` finds `claude-opus-5-5`). Pass `prices` when rates change or for other providers. Without a report, usage or price the cost is 0 and `costSource` is `unknown`, so totals understate spend for such runs; `AiUsageTotals.unknownCost` counts them.

## Budgets

The scoped setting `llm.budget`, one weekly limit:

```json
{ "weeklyUsd": 150, "reserveUsd": 25, "action": "block", "warnPercent": 80 }
```

- Every field has a default: `weeklyUsd` 150, `reserveUsd` 25, `action` `block`, `warnPercent` 80. `warnPercent` (a whole percent, 1 to 100) never blocks: from that share of `weeklyUsd` the budget reads as close to the limit, and the server puts one `budget` Inbox item per budget and week in front of people who may change it. Without a valid global (`all`) entry the default budget (id `default`) applies to everything.
- The week runs from Monday 00:00 to the next Monday 00:00 in the instance time zone (the process's local zone; `timeZone` overrides it). Spend of a budget is the cost of every run its scope covers this week: a group budget is shared by the group, a global one by everything.
- For a run, these budgets apply: the most specific one covering the repository (exact path > glob > subgroup > group > all, newest among equals, as for every setting), the newest global one when that is a different entry, and, when the most specific one names only subgroups, the most specific covering budget on their parent groups, so a subgroup budget adds a cap but never lifts its repositories out of the parent's.
- Before a run, its cost is estimated (`estimateUsd`, default the mean cost of this week's runs of its task kind that were not denied). **Automatic** work (schedules, triggers, webhooks, freshness) exceeds a budget when spend so far plus the estimate goes above `weeklyUsd - reserveUsd`; **interactive** work (`interactive: true`: a person clicked, chat, a command on a merge request) only above `weeklyUsd`, so the reserve stays for people.
- `warn` lets the run go on; `block` denies it. The decision's `remainingUsd` is what the run may still spend under the `block` budgets; agents stop once a run spends it (`AgentTask.maxCostUsd`).
- The first time a budget is exceeded in a week (per kind of work) an `ai.budget_exceeded` audit event is appended (target the budget and the repository, `outcome: 'denied'` for `block` budgets) (deduplicated in process memory, so a restart may log it once more).
- `budgetGuard({ settings, usage, audit?, now?, timeZone?, cacheMs? })` caches spend for `cacheMs` (30 s) and adds recorded runs to the cached values (`note`), so a burst of runs costs one aggregate per budget.

`budgetStatuses(entries, usage, now, { timeZone?, includeDefault? })` reports every budget with this week's spend in its scope and the automatic part of it, percent of `weeklyUsd`, `reserveUsd`, `warnPercent`, the forecast by week end and `automaticStopsAt` (see below) and the week's range; `includeDefault` adds the default budget when no global entry exists. `broadestBudget(statuses)` picks the one covering the most: a global budget, else the least specific scope, the fullest among equals.

## Forecasts

`spendForecast(usage, now, { filter?, timeZone?, perDay? })` says where this budget week's spend is heading over the usage `filter` matches (a budget's scope, what a caller may read): `spentUsd` and `automaticUsd` so far, plus for the rest of the week the mean spend of the same remaining span (same weekday and time to Monday 00:00) over the last 4 full weeks — `forecastUsd` and `automaticForecastUsd`. `automaticWeeklyMeanUsd` is the mean automatic spend of those full weeks, `weeks` how many were averaged. Weeks before the first one with matching usage are not averaged, so a new instance is not diluted by empty weeks; with none the pace so far is extended to the week's end (as if at least one day had passed, `weeks: 0`). A forecast is never below what the week already spent. There is no linear projection of a period's spend. With `perDay` it also returns `days`: the rest of the week split by local day (`weekDays`), today first from now to midnight, each the mean of that span over the same averaged weeks (or, without history, the extended pace spread by each day's remaining length, so a 25-hour day gets more); their sums equal `forecastUsd - spentUsd` and `automaticForecastUsd - automaticUsd`. It costs one aggregate per remaining day and averaged week, so budgets do not ask for it; `GET /api/ai/overview` does.

`automaticStopsAt(budget, forecast, now)` is when the week's spend is expected to reach `weeklyUsd - reserveUsd`, the point where the budget guard stops automatic work, spreading the forecast's remaining spend evenly over the rest of the week; `undefined` when the forecast stays at or below it, or spend already reached it.

## Breakdowns

`weekBreakdown(usage, week, filter?)` splits one week's usage by task kind, analyzer (runs without one under `''`) and provider, most expensive first (`byCost`), with the week's totals (`usageTotals`). `GET /api/ai/week` and the `budget_status` tool read it.

Other splits come straight from the store's aggregate (`AiUsageStore.aggregate`): `GET /api/ai/usage?groupBy=` takes any comma list of `AiUsageDimension` (`day`, `week`, `month`, `repo`, `group`, `model`, `provider`, `taskKind`, `analyzer`, `origin`) with the same filters as `GET /api/ai/runs` (`from`, `to`, `origin`, `outcome`, `repo`, ...). The panel's Ops › AI spend page reads it as `day,origin` for four weeks of daily people (`interactive`) against automatic spend, and as `taskKind`, `repo` and `model,provider` for the period's breakdowns; records keep only the raw `taskKind`, grouped into product features by the map below.

## Features

`@holtkeeper/ai-usage/features` (also re-exported from the package root) is dependency-free so the web app imports it too. `featureTaskKinds` lists the task kinds of each named feature (`reviews`, `tasks`, `chat`, `knowledge`, `releases`), `featureOf(taskKind)` maps a kind back (`other` for any kind no list names, and for an empty one), `featureLabel` names them, and `filterableFeatures` / `isFilterableFeature` are the features a filter can narrow to (every one but `other`). The server turns `feature=` into `AiUsageFilter.taskKinds`; the web labels runs and breakdowns with the same map (see [the web docs](../../../apps/web/docs/spend.md)).

## Pure helpers

`weekRange(now, timeZone?)`, `previousWeek(week, timeZone?)`, `weekDays(week, timeZone?)` (the week's seven local days, keyed by local date, covering it exactly across clock changes), `monthRange(now)`, `periodSpans(kind, now, timeZone?)` (a `week`, `month` or `30d` period from its start to now and the same elapsed span of the period before: last week from Monday 00:00 to the same weekday and time, the same days of the previous month cut at its end, the 30 days before; keyed by the Monday, the month or `30d:` with the last day), `instanceTimeZone()`, `parseBudgets`, `defaultBudget`, `withDefaultBudget`, `applicableBudgets`, `limitFor`, `withCostCap`, `costOf`, `computeCost`, `priceFor`, `usageEntry`, `partialUsage`. `budgetSchema` mirrors the definition in `@holtkeeper/settings`, which this package does not depend on.
