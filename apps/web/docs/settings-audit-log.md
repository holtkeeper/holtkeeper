# Settings › Audit log

Part of the web app's [Settings](README.md#audit-log) docs.

Route `/settings/audit`, page `features/audit-log/AuditLogPage.tsx`, summary and chain check hooks in `api/settings-system.ts`, labels in `lib/audit-labels.ts`, filters in `lib/audit-log.ts`.

**Who sees what** (decision 9). Global `audit:read` sees every event, the chain banner, Verify chain and Export. `repos:read` alone sees only events of repositories it can read, never instance events; the server enforces it, the page only hides the controls (`HistoryScope.instance`).

**Header.** Scope switch (My teams narrows to readable repositories in the home groups, a picked group to those in that group; My teams without home groups shows `NoTeamsState`; placeholders until the scope is known, `useScope().ready`), a search over the loaded events (`auditEventMatches`: action label or name, target id or type, `#seq`, event id prefix), `FilterButton`s _Area_, _Repository_, _Person_ (the summary's actors) and _Outcome_, and the time range as `SegmentedTabs` (24 h, 7 days by default, 30 days, All). A `?repo=<forge:path>` link (the hub's Activity tab sends one) starts the log filtered to that repository. Verify chain runs `GET /api/audit/verify` and replaces the daily result in the banner; Export (CSV, NDJSON) sits in the ⋯ menu.

**Chain banner.** `chainStatus(last, newestSeq, manual?)`: `Chain intact` with how many events the check covered (`#1–#48,206`), when the daily check ran and how many newer events wait for the next one; `Chain broken at #n` with the reason; `Not checked yet` before the first check. Data from `useLastAuditVerify` (`GET /api/audit/verify/last`).

**Strip.** `auditStripCounts` over `useHistorySummary` for the same filters: events in the range, denied and failed (two more summary requests with `outcome`), and how many people and agents acted, plus `system` when Holtkeeper itself did. Actor kinds come from `auditActorKind` (`agent:` ids are agents; `system` and job or system providers are Holtkeeper).

**Table.** Events newest first, grouped by the viewer's local day (`auditDays`: Today, Yesterday, the weekday within a week, else the date; the full date beside it). Columns: time (`formatClock`) with `#seq` (`formatSeq`), actor (filters by them), action as a sentence (`auditActionLabel`, falling back to `Changed a trigger`-style text for unknown actions) with the outcome when it was not a success, target, scope (`auditScopeLabel`: the repository or Organization). Load older pages through the cursor; the footer (`ListFooter`) says how many of the total are shown (with a search, how many of the loaded events match) and hints J/K, which open the first or last row.

**Sheet.** A row opens the event: `#seq`, "n of total", previous and next, Only <person>, tabs Event, Changes and Details. Event shows who, outcome, request facts, scope, hash, the previous hash with its `#seq`, and whether the last chain check covered it.
