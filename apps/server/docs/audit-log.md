# Audit log

Part of the [@holtkeeper/server](README.md) docs.

Server side of Settings › Audit log: `GET /api/history/summary` over `AuditStore.summary` and the daily chain check behind `GET /api/audit/verify/last`. The event model, `GET /api/history` and the access rules are in [Audit log](README.md#audit-log).

## Access (decision 9)

Every audit route in `src/routes/audit.ts` narrows the filter the same way (`visibleFilter`): a global `audit:read` sees every event, filters as given. Otherwise the caller needs `repos:read` somewhere (403 `repos:read` without it) and sees only events whose `target.repo` it can `repos:read`; `repos` narrows within those, and instance events (settings, users, credentials, the chain check) never show, even with a global `repos:read`. Export, `GET /api/audit/verify` and `GET /api/audit/verify/last` need a global `audit:read`.

## `GET /api/history/summary`

Takes the filters of `GET /api/history` (`actor`, `action` prefix, `targetType`, `targetId`, `repo`, `repos`, `outcome`, `via`, `from`, `to`) and answers `HistorySummary`: the store's `AuditSummary` (`total`, events per UTC day, per action, per actor with the newest name, per repository) of the events the caller may see, plus `people` (name and avatar of every user among the actors). Unfiltered only with a global `audit:read`; otherwise a summary of the visible repositories. The web asks it three times per filter (all, `outcome=denied`, `outcome=error`) for the summary strip.

## Daily chain check

A leader duty (`periodicDuty('audit chain check', …)` in `startServer`) calls `verifyAuditChainIfDue(store, now)` from `src/audit-verify.ts` every hour. It checks the whole chain (`AuditStore.verifyChain()`) only when the last check is a day old or missing, so a leader that restarts often still checks once a day. The result is kept in kv under `audit:verify:last` (`{ at, result }`) and an `audit.verify` event is appended by the system (`via: 'system'`, outcome `error` when the chain is broken, details the `AuditVerification`), so the log shows when it was checked.

`GET /api/audit/verify/last` answers `AuditVerifyLast { at?, result? }` from `lastAuditVerification(kv)`; both fields are absent before the first check or without `kv`. A check by hand stays `GET /api/audit/verify?fromSeq=&toSeq=` and is not recorded.
