# Settings › Integrations

Part of the web app's [Settings](README.md#settings) docs.

Route `/settings/integrations`, body `features/settings/sections/IntegrationsSection.tsx`, endpoints and hooks in `api/settings-ai.ts`. Server side: [apps/server/docs/integrations.md](../../server/docs/integrations.md).

From top to bottom:

- **Summary line** (`IntegrationsStrip` in `features/credentials/IntegrationTables.tsx`): forges and their repositories, per forge whether changes arrive by webhook (with the last delivery) or polling, the number of credentials and how many need attention (`needsAttention`).
- **Forges** (`features/credentials/ForgesSection.tsx`, global `settings:read`): each panel forge with its token, how its repositories are named, the repository count and the last webhook delivery from `GET /api/integrations/forges`, then its webhook and SSH key controls. **Add forge** (global `settings:write`) is the section header's primary action; _Add credential_ and the Slack token form's Save are secondary.
- **Credentials** (`features/credentials/CredentialsTable.tsx`, `credentials:read`): every credential except AI provider keys (those live in Settings › AI). Search by name, host or kind; segments All, Forge tokens, Proxy secrets, Other (`credentialGroup`). Columns: name and URL, kind, Used by (`usedByLabel`, linking to the first use), Usable by (scope), expiry, rotation, Last used (`lastUsedLabel`) and status with its reason (`credentialStatus`). Sorted by status, then expiry (`sortCredentials`). GitHub tokens show their library index usage under the row. Rotate, Edit and Delete for `credentials:write`; deleting names what stops working.
- **Trackers** (`ConfiguredTables`): only stored values, each tracker of the `trackers` setting entries (`trackerRows`): name, id, entity, sources, rules, outputs and scope.
- **Request limits** (`ConfiguredTables`, global `settings:read`): live usage from `GET /api/limits/usage` (`useLimitUsage` in `api/limits.ts`, refetched every 15 s). One row per credential with a limit, a `limits.credentials` entry or recorded use (only credentials the viewer may read with `credentials:read`), `Forge <id>` keys and configured keys that name nothing (last). Columns (`limitUsageViews`): credential and kind; the limit with per-minute policies shown per hour (`300 per minute` reads `18,000 requests / hour`; AI keys in tokens) and whether it is set here or the kind default; used in the last hour with a bar against that limit; in flight against `maxConcurrent`; daily token and cost caps with today's use; status; a link to the editor. The description says when counts cover only the answering server process.
- **Trackers, release webhooks and limits**: the section's setting entries per scope (`trackers`, `analyzers.tracker`, `releases.notify`, `limits.credentials`), where those values are edited (`TrackerEditor` for trackers).
- **Slack** (`SlackTokensSection`, global `settings:read`): the stored Slack app tokens, kept for a future integration.

## Credential status

`lib/credential-status.ts`, most urgent first: _Expired_ (expiry passed), _Failing_ (the last rotation failed, or the last tool-use test of an AI provider), _Expires soon_ (within 14 days), _Unused_ (nothing refers to it and nothing used it for 30 days, counted from creation when never used), _Healthy_. Each carries a tone and, except Healthy, a reason. `lastUsedAt` is recorded at most once a minute, so a use in the last minute reads _Within a minute_.

## Request limit status

`limitStatus` in `lib/credential-status.ts`, most urgent first: _Daily cap reached_ (today's tokens or cost reached `tokensPerDay` or `costPerDayUsd`), _Cooling down until <time>_ (a rate-limit answer started a cool-down that is still running), _Near limit_ (90% of an hourly or daily limit used, or a rate-limit answer within the last hour, which also catches calls made with the same token outside Holtkeeper), _Within limit_, and _No limit_ for keys without any limit. Rows sort by that order, then by name.
