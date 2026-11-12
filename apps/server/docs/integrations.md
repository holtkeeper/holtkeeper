# Integrations

Part of the [@holtkeeper/server](README.md) docs.

Server side of Settings › AI and Settings › Integrations: forges, credentials and what uses them, the weekly budget with its spend per feature and scoped caps, the agent tool registry and the budget warning in the Inbox. Contracts live in `@holtkeeper/api` (`settings-ai.ts`, `CredentialView`, `InboxBudgetItem`).

## Credentials

`routes/credentials.ts`. Every route checks `credentials:read` or `credentials:write` against the credential's scope; validation and sealing happen in [@holtkeeper/credentials](../../../packages/credentials/docs/README.md).

- `GET /api/credentials` lists the credentials the caller may read, each with `usedBy` and `lastUsedAt`.
- `usedBy` names what refers to the credential, computed over every stored credential: panel forges by token (`kind: forge`, `label: Forge <id>`) and by SSH key (`SSH key of <id>`), the global `llm.provider` (`setting`, `Agents`, only for AI provider kinds), the global `libraries` setting's `github` list by id or name, or every `github` credential when it is unset (`setting`, `Library index`), and services that use every credential of their kind (`service`): `egress-secret` (job network proxy), `jira` (issue lookups), `confluence` (documents). `href` is a `webPaths` link where one exists. An empty list means nothing refers to it.
- `lastUsedAt` comes from `CredentialService.reveal` and `markUsed` (at most once a minute per credential and process). Panel GitLab forges record a use for each request that goes out (`managed.ts`); rebuilding the config every minute reads their tokens with `open`, which records nothing. Code that opens a credential's sealed secret through the vault directly does not record a use; see Known gaps.
- `POST`, `PATCH`, `DELETE /api/credentials/:id` and `POST /api/credentials/:id/rotate` write `credential.create`, `credential.update`, `credential.delete` and `credential.rotate` audit events; the secret shows as redacted and `createdAt`, `updatedAt`, `lastUsedAt` are left out of the changes. Scheduled rotations are audited by the service as the system actor.
- `POST /api/credentials/:id/test` and `GET /api/credentials/:id/models` read the AI provider's secret through `open`, so probing a credential does not count as a use.

## Forges

`GET /api/integrations/forges` (in `routes/credentials.ts`) needs a global `settings:read`: the repository counts cover every repository, so a narrower grant gets 403. One row per panel forge document: `id`, `kind`, `url`, `credentialId`, `repos` (repositories polling listed on the forge plus exact group includes, as `listedRepos`), `webhook` (a webhook secret is set up, on the forge document or in `jobs.webhooks.<id>`), `lastWebhookAt` and `webhookHealth` (`WebhookHealthSummary` of the last disabled-hook check: `checkedAt`, `total`, `disabled`, `missing`, `unknown`, `reenabled24h`; absent before the first check).

`POST /api/integrations/forges/:id/webhooks/reenable` (global `settings:write`, 404 for an unknown forge, 503 without `store.kv`) runs `checkWebhookHealth` for the forge now, re-enabling disabled hooks without waiting for a retry (but at most one test delivery per hook a minute, and joining a check already running), and answers `WebhookReenableResult` `{ checked, reenabled, failed, hooks }`. Audited as `forge.webhooks_reenable` with the counts, plus one `webhook.reenabled` per hook attempted. On GitLab the re-enable is a test delivery of an event Holtkeeper ignores (a test push only when GitLab cannot build another, and that push is ignored too), so it starts no push triggers or release assistant work.

`routes/webhooks.ts` records a forge's last delivery (`recordForgeDelivery` in `webhook-sync.ts`, kv `webhooks:forge:<id>:last`, kept 30 days) for every authenticated delivery whose forge is known: `POST /webhooks/<forge>` and `/webhooks/r/<token>` right after the secret check, handled or ignored; `POST /webhooks/gitlab` once a delivery names a repository of a known forge. Deliveries with a wrong secret record nothing. `lastForgeDeliveries` reads them back.

## Request limits usage

`GET /api/limits/usage` (`routes/limits.ts`, `limitUsage`) needs a global `settings:read` and returns `LimitUsageList { rows, shared, readAt }`, cached 5 seconds per process unfiltered; each answer then keeps a credential row only when the caller has `credentials:read` on that credential's scope, while `forge:<id>` rows and configured keys that name nothing show to everyone allowed in. Before reading the limiter's `snapshot()` it resolves every credential's policy (kind defaults plus the everything-scope `limits.credentials` entry) and configures it, so a web process that ran none of the work still refills buckets with the right policy. Rows:

- every credential whose policy has a limit, that a `limits.credentials` entry names (by id or name; `source: 'configured'`, else `default`) or that has recorded use (requests or tokens in the last hour, leases held, tokens today, a rate-limit answer);
- `forge:<id>` keys of known forges as `Forge <id>`, with the forge's kind;
- configured keys that name no credential or forge, with `missing: true`, sorted last.

Each row carries the effective `policy` (rates, concurrency, daily caps; no backoff), `requestsLastHour` and `tokensLastHour` from the limiter's rolling window, `inFlight`, `coolDownUntil`, `last429At`, `dayTokens` and `dayCostUsd`. `shared` is `limits.distributed`: without it every process counts only its own calls. Not counted: queues of other processes, calls made with the same token outside Holtkeeper and egress-proxy downloads; the forge's own rate-limit headers are not read.

## AI budget and tools

`routes/ai.ts`. Both routes need `ai:read` (or `ai:admin`) somewhere.

- `GET /api/ai/budget`: the current budget week, this week's spend and runs over the usage the caller's grants cover, `budget` (the readable budget covering the most, as `broadestBudget` over `budgetStatuses`; the default budget is included only for a global `ai:read`), `budgetChanged` (who and when changed the global `llm.budget` entry), `byFeature` (spend per task kind, `other` for runs without one, largest first, zero-cost kinds left out) and `scopes` (readable `llm.budget` entries narrower than everything, fullest first). Features have no caps of their own; task kinds group into features by `featureOf` of `@holtkeeper/ai-usage/features`.
- `GET /api/ai/tools`: the tool registry, built once per process from the same toolset factories internal agents and the MCP endpoint use, with an inert context, so it lists definitions only. `usedBy` names the task kinds whose agents mount the tool's toolset (`review`, `chat`, `write-task`, from `taskToolsets`) and `mcp` for MCP clients; a tool served under one name by both counts once. Sorted by toolset, then name. Read-only: tools cannot be switched off.

## Budget warning in the Inbox

`inbox.ts` adds a `budget` item for every budget (stored `llm.budget` entries and the default one) whose spend this week reached `warnPercent` of `weeklyUsd`. Its id is `budget:<setting id or default>:<week key>`, so it appears at most once per budget and week; the first time it was seen is kept in kv (`inbox:budget:<id>:<week>`, 8 days) and becomes `createdAt`. `dueAt` is the week's end. It shows to principals with `ai:read` and `settings:write` on the budget's scope, in the section its scope's teams decide. There is nothing to approve: people acknowledge it by snoozing it until the week ends.

## Known gaps

- `agent.ts`, `documents.ts` and `issues.ts` open AI provider, Confluence and Jira secrets through the vault directly, so those uses do not move `lastUsedAt` yet; they should call `credentials.reveal` or `credentials.markUsed`.
