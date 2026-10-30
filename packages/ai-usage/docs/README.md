# @holtkeeper/ai-usage

Records what LLM agent runs use and cost, and enforces spending budgets. Records live in the store's `aiUsage` part (see [@holtkeeper/store](../../store/docs/README.md)); the server exposes them under `/api/ai/*` (see [the server docs](../../../apps/server/docs/README.md)).

## What is recorded

One `AiUsageRecord` per agent run: when it started, the repository and the config groups it had at that moment, task kind, analyzer, job and analysis ids when known, actor, provider (credential id or name, or `anthropic`), model, input / output / cache read / cache write tokens, cost and where it came from, duration, turns and the outcome:

- `ok` — the agent returned.
- `error` — the agent threw; the error message is kept, and so are tokens, cost and turns when the error carries them (`usage`, `costUsd`, `turns` properties).
- `denied-budget` — a `block` budget stopped the run before the agent was called; tokens and cost are 0.

Prompts and answers are never recorded.

## Recording runs

- `meteredAgent(agent, { record, budgets?, context, prices?, now?, onRecordError? })` wraps an `Agent`. `context` says who and what the runs are for (`repo` with groups, `actor`, `provider`, `model`, optional `taskKind`, `analyzer`, `jobId`, `analysisId`); the task's own `taskKind` wins over the context's, `agent` is the fallback. With `budgets` every run is checked first; a denial is recorded and thrown as `BudgetExceededError` (with the `exceeded` limits). Results and errors pass through unchanged; a failing `record` is reported to `onRecordError` (default `console.error`) and never replaces them.
- `usageRecorder(store.aiUsage, { prices?, now?, groupsOf?, budgets? })` returns an `onRun(info)` hook for agent wrappers that report `{ repo, taskKind, provider, model, result | error, durationMs }` (plus optional `actor`, `analyzer`, `jobId`, `analysisId`, `at`). A `BudgetExceededError` is stored as `denied-budget`.

## Costs

`costUsd` is the provider's reported cost when the agent result has one (`costSource: reported`; the Claude Agent SDK reports it). Otherwise it is computed from the token counts and a price table (`computed`): USD per million input, output, cache read and cache write tokens. `defaultPrices` holds Anthropic list prices as of 2026-10 with cache writes at the 5-minute rate; a model id matches its exact entry or the longest entry it contains (`anthropic.claude-opus-5-5` finds `claude-opus-5-5`). Pass `prices` when rates change or for other providers. Without a report, usage or price the cost is 0 and `costSource` is `unknown`, so totals understate spend for such runs.

## Budgets

The scoped setting `llm.budget`:

```json
{ "monthlyUsd": 200, "dailyUsd": 20, "perTaskKind": { "review": 50 }, "action": "block" }
```

- `monthlyUsd` / `dailyUsd` limit spend per UTC calendar month / day; `perTaskKind` limits a task kind per month.
- Spend of a budget is the cost of every run its scope covers: a group budget is shared by the group, a global (`all`) budget by everything.
- For a run, two budgets apply: the most specific one covering the repository (exact path > glob > group > all, newest among equals, as for every setting) and the newest global one when that is a different entry.
- A limit is reached when spend so far is at or above it, so the run that crosses a limit still runs and the next one is checked.
- `warn` lets the run go on; `block` denies it. Either way the first time a limit is reached in a period an `ai.budget.exceeded` activity event is appended (deduplicated in process memory, so a restart may log it once more).
- `budgetGuard({ settings, usage, activity?, now?, cacheMs? })` caches each limit's spend for `cacheMs` (30 s) and adds recorded runs to the cached value (`note`), so a burst of runs costs one aggregate per limit.

`budgetStatuses(entries, usage, now)` reports every budget's limits with spend, percent used and, for monthly limits, the projected month-end spend (linear in elapsed time).

## Pure helpers

`periodRange(period, now)`, `previousMonth(now)`, `projectMonthEnd(spent, now)`, `parseBudgets`, `applicableBudgets`, `budgetLimits`, `limitReached`, `costOf`, `computeCost`, `priceFor`, `usageEntry`, `partialUsage`. `budgetSchema` mirrors the definition in `@holtkeeper/settings`, which this package does not depend on.
