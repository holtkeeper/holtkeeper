# @holtkeeper/ai-usage

Records what LLM agent runs use and cost, and enforces spending budgets. Records live in the store's `aiUsage` part (see [@holtkeeper/store](../../store/docs/README.md)); the server exposes them under `/api/ai/*` (see [the server docs](../../../apps/server/docs/README.md)).

## What is recorded

One `AiUsageRecord` per agent run: when it started, the repository and the config groups it had at that moment, task kind, analyzer, job and analysis ids when known, actor, provider (credential id or name, or `anthropic`), model, input / output / cache read / cache write tokens, cost and where it came from, duration, turns and the outcome:

- `ok` — the agent returned.
- `error` — the agent threw; the error message is kept, and so are tokens, cost and turns when the error carries them (`usage`, `costUsd`, `turns` properties).
- `denied-budget` — a spend limit stopped the run: a `block` budget refused it before the agent was called (tokens and cost 0), or the run failed with `BudgetExceededError` (a provider refusal or its own cost cap; whatever it used is kept).

Prompts and answers are never recorded.

## Recording runs

- `meteredAgent(agent, { record, budgets?, context, prices?, now?, onRecordError? })` wraps an `Agent`. `context` says who and what the runs are for (`repo` with groups, `actor`, `provider`, `model`, optional `taskKind`, `analyzer`, `jobId`, `analysisId`, `interactive`); the task's own `taskKind` wins over the context's, `agent` is the fallback. With `budgets` every run is checked first; a denial is recorded and thrown as `BudgetDeniedError` (with the `exceeded` budgets), and an allowed run gets `maxCostUsd` lowered to what the budget has left (`withCostCap`). Results and errors pass through unchanged; a failing `record` is reported to `onRecordError` (default `console.error`) and never replaces them.
- `usageRecorder(store.aiUsage, { prices?, now?, groupsOf?, budgets? })` returns an `onRun(info)` hook for agent wrappers that report `{ repo, taskKind, provider, model, result | error, durationMs }` (plus optional `actor`, `analyzer`, `jobId`, `analysisId`, `at`, `transcriptRef`). A `BudgetExceededError` is stored as `denied-budget`.
- `BudgetDeniedError` is a `BudgetExceededError` of `@holtkeeper/agent` (same `name`), so everything that recognizes a spend stop, the job worker included, treats a pre-run refusal the same way.

## Costs

`costUsd` is the provider's reported cost when the agent result has one (`costSource: reported`; the Claude Agent SDK reports it). Otherwise it is computed from the token counts and a price table (`computed`): USD per million input, output, cache read and cache write tokens. `defaultPrices` holds Anthropic list prices as of 2026-10 with cache writes at the 5-minute rate; a model id matches its exact entry or the longest entry it contains (`anthropic.claude-opus-5-5` finds `claude-opus-5-5`). Pass `prices` when rates change or for other providers. Without a report, usage or price the cost is 0 and `costSource` is `unknown`, so totals understate spend for such runs.

## Budgets

The scoped setting `llm.budget`, one weekly limit:

```json
{ "weeklyUsd": 150, "reserveUsd": 25, "action": "block" }
```

- Every field has a default: `weeklyUsd` 150, `reserveUsd` 25, `action` `block`. Without a valid global (`all`) entry the default budget (id `default`) applies to everything.
- The week runs from Monday 00:00 to the next Monday 00:00 in the instance time zone (the process's local zone; `timeZone` overrides it). Spend of a budget is the cost of every run its scope covers this week: a group budget is shared by the group, a global one by everything.
- For a run, two budgets apply: the most specific one covering the repository (exact path > glob > group > all, newest among equals, as for every setting) and the newest global one when that is a different entry.
- Before a run, its cost is estimated (`estimateUsd`, default the mean cost of this week's runs of its task kind that were not denied). **Automatic** work (schedules, triggers, webhooks, freshness) exceeds a budget when spend so far plus the estimate goes above `weeklyUsd - reserveUsd`; **interactive** work (`interactive: true`: a person clicked, chat, a command on a merge request) only above `weeklyUsd`, so the reserve stays for people.
- `warn` lets the run go on; `block` denies it. The decision's `remainingUsd` is what the run may still spend under the `block` budgets; agents stop once a run spends it (`AgentTask.maxCostUsd`).
- The first time a budget is exceeded in a week (per kind of work) an `ai.budget_exceeded` audit event is appended (target the budget and the repository, `outcome: 'denied'` for `block` budgets) (deduplicated in process memory, so a restart may log it once more).
- `budgetGuard({ settings, usage, audit?, now?, timeZone?, cacheMs? })` caches spend for `cacheMs` (30 s) and adds recorded runs to the cached values (`note`), so a burst of runs costs one aggregate per budget.

`budgetStatuses(entries, usage, now, { timeZone?, includeDefault? })` reports every budget with this week's spend, percent of `weeklyUsd`, `reserveUsd`, the projected spend by week end (linear in elapsed time) and the week's range; `includeDefault` adds the default budget when no global entry exists.

## Pure helpers

`weekRange(now, timeZone?)`, `monthRange(now)`, `previousMonth(now)`, `projectPeriodEnd(spent, range, now)`, `instanceTimeZone()`, `parseBudgets`, `defaultBudget`, `withDefaultBudget`, `applicableBudgets`, `limitFor`, `withCostCap`, `costOf`, `computeCost`, `priceFor`, `usageEntry`, `partialUsage`. `budgetSchema` mirrors the definition in `@holtkeeper/settings`, which this package does not depend on.
