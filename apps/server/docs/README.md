# @holtkeeper/server

The web server: the JSON API for the UI and clients, the active auth provider's endpoints, the built web UI, and background credential rotation. Built on Hono over `Bun.serve`.

## Running

Add a `server` section to `holtkeeper.config.ts` and run `holtkeeper serve`:

```ts
import { passwordAuth } from '@holtkeeper/auth-password'
import { defineConfig, env } from '@holtkeeper/core'
import { sqliteStore } from '@holtkeeper/store-sqlite'

export default defineConfig({
  forges: {/* ... */},
  server: {
    auth: passwordAuth({
      password: env('HOLTKEEPER_PASSWORD'),
      sessionSecret: env('HOLTKEEPER_SESSION_SECRET'),
    }),
    store: sqliteStore({ path: 'holtkeeper.db' }),
    vaultKey: env('HOLTKEEPER_VAULT_KEY'),
    port: 7420,
  },
})
```

| Field                     | Default                                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth`                    | required: `noAuth()`, `headerAuth()`, `passwordAuth()` or `usersAuth()`                                                                                                         |
| `store`                   | required: `sqliteStore()`, `postgresStore()` (several processes) or `memoryStore()`                                                                                             |
| `vaultKey`                | required, at least 32 characters; seals credentials and secret settings                                                                                                         |
| `hostname`, `port`        | `127.0.0.1`, `7420`                                                                                                                                                             |
| `webRoot`                 | `apps/web/dist`; without a built UI only the API is served                                                                                                                      |
| `rotationIntervalMinutes` | 60; `0` disables background rotation                                                                                                                                            |
| `artifactsDir`            | `.holtkeeper/artifacts`; shorthand for `artifacts: { kind: 'fs', dir }`                                                                                                         |
| `artifacts`               | `{ kind: 'fs', dir }` or `{ kind: 's3', bucket, endpoint?, region?, accessKeyId, secretAccessKey, sessionToken?, prefix?, virtualHostedStyle? }` (secrets accept `env('NAME')`) |
| `retention`               | none; `{ days?, maxBytes? }` sweeps artifacts hourly (age first, then least recently used)                                                                                      |
| `databasePath`            | none; the SQLite file, so the storage overview can report its size                                                                                                              |

## Structure

- `context.ts` — `ServerDeps` (config, auth, store, vault, credential service, setting definitions, clock) and helpers: `authorize`, `principalOf`, `repoTarget` (adds config groups to a repository), `readBody` (zod validation → 400).
- `app.ts` — `createApp(deps)`: authenticates every request, mounts `/auth/<provider>/*` and the API routes, maps errors to `ApiError`.
- `routes/` — one module per area: audits and repositories, analyses, credentials, settings, jobs, knowledge, webhooks, AI usage, the audit log (`audit.ts`), external accounts and avatars. Each checks permissions with `@holtkeeper/access` and filters lists to what the caller may see.
- `audit.ts` — the audit middleware, `appendAudit`, `diffChanges` and audit retention (see [Audit log](#audit-log)).
- `web.ts` — static UI with SPA fallback and immutable caching for hashed assets.
- `agent.ts` — `settingsAgentFor` and `withServerDefaults`: the LLM agent per repository (see [Agents](#agents)).
- `managed.ts` — `startManagedConfig`: the `ConfigSource` over the file config and `store.config` (see [Managed configuration](#managed-configuration)).
- `limits.ts` — the shared `@holtkeeper/limits` limiter: limited forge `fetch`, job admission keys.
- `server.ts` — `startServer(config)`: builds deps from the config, starts rotation, logs provider start lines, listens.

Everything a route needs comes through `ServerDeps`, so tests build the app with `memoryStore()` and any auth provider (see `test/app.test.ts`).

## Permissions per endpoint

| Endpoint                    | Needs                                                                                                                                                                                                                                                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| audit runs, repository list | `audits:read` / `repos:read` on the repository (lists are filtered); `GET /api/repos` lists audited repositories plus exact paths in group `include` lists, so repositories added in the panel show up before their first audit; with `analyses:read` each entry carries the newest record of every analysis kind |
| `GET /api/dependencies`     | `analyses:read` on each repository; the inventory is built from the newest `depgraph` record of the repositories the caller may read (up to 2000 newest records are scanned)                                                                                                                                      |
| `POST /api/audit-runs`      | `audits:run` on the repository                                                                                                                                                                                                                                                                                    |
| credentials                 | `credentials:read` / `credentials:write` on the credential's scope                                                                                                                                                                                                                                                |
| settings                    | `settings:read` / `settings:write` on the entry's scope; resolve needs `settings:read` on the repository                                                                                                                                                                                                          |
| activity                    | `users:read` on everything                                                                                                                                                                                                                                                                                        |
| jobs                        | `analyses:read` on the repository (lists are filtered); queueing and canceling need `analyses:run`                                                                                                                                                                                                                |
| knowledge                   | `knowledge:read` / `knowledge:write` on the entry's scope (lists are filtered); `?repo=` needs `knowledge:read` on the repository and lists every entry covering it                                                                                                                                               |
| AI usage                    | `ai:read` (or `ai:admin`); rows limited to repositories the grants cover, using the groups recorded on each run; `?repo=` needs `ai:read` on the repository                                                                                                                                                       |
| managed config              | global `settings:read` to view (incl. export and schedule previews), global `settings:write` to change (incl. webhook secrets)                                                                                                                                                                                    |
| audit log (`/api/audit*`)   | global `audit:read`                                                                                                                                                                                                                                                                                               |
| own external accounts       | any signed-in principal, only for its own links                                                                                                                                                                                                                                                                   |
| avatars                     | none (`GET /api/avatars/*`); `PUT /api/me/avatar` needs a signed-in `users` account                                                                                                                                                                                                                               |

## Agents

`agent.ts` builds the LLM agent jobs get (`settingsAgentFor({ config, store, vault, now?, runner?, context7?, onRun?, budgets?, log?, models? })`, the default `agentFor` of `startServer`). For a repository it reads the scoped settings:

1. `llm.provider` set to the id or name of an AI provider credential (kind `anthropic`, `anthropic-compatible`, `bedrock`, `vertex` or `openai-compatible`, scope covering the repository): the credential's secret is opened with the vault and `createAgent` from [@holtkeeper/agent](../../../packages/agent/docs/README.md#providers) builds the agent from its `kind`, `url` and `options`. A named credential that is missing, out of scope or has invalid options is logged and yields no agent.
2. `llm.provider` unset: no agent. API keys live only in credentials, never in settings.
3. `llm.model` / `llm.models` override the provider's models. A `<prefix>@latest` reference (in the settings or the credential's options) resolves to the newest model the provider lists (`resolveProviderRouting`, listings cached per credential for an hour in `models`, default `modelCatalog()`); one that matches nothing is logged and yields no agent. Runs of one credential share its `maxConcurrency`.

`GET /api/credentials/:id/models` (`credentials:read`) lists an AI provider credential's models with prices (`listProviderModels`, 15 s timeout); a provider API failure comes back as `error` next to the configured models.

`ai-sdk` credentials (see [@holtkeeper/agent](../../../packages/agent/docs/README.md#ai-sdk-adapter)) use the models.dev catalog (`ServerOptions.aiCatalog`, default `modelsDevCatalog()`) with the catalogs of the config's `ai.providers` plugins added ([provider plugins](../../../packages/agent/docs/README.md#provider-plugins); credentials may name their packages): `GET /api/ai/providers` lists the providers Holtkeeper can talk to and the AI SDK packages (shipped and plugins') a provider of your own can use (any signed-in caller; a catalog that cannot load comes back as `error`), `GET /api/ai/providers/:id/models` one provider's models. Their credential models come from the catalog, catalog prices price their runs (a credential's `pricing` wins), and `POST /api/credentials/:id/test { model? }` (`credentials:write`) asks the model (default the credential's `model`) for a one-word reply: `CredentialTestResult { ok, model, reply?, latencyMs?, error? }`.

The agent is wrapped by `withServerDefaults(agent, options)`, so every task gets:

- toolsets `code` (`codeTools`), `docs` (`docsTools`, with the job's runner when the caller passes `{ runner }` as second argument of `agentFor`, else `runner`) and `knowledge` (`knowledgeTools(knowledgeAccess({ store, autoAccept }))` for the repository and the task's kind, `autoAccept` from the scoped `knowledge.autoAccept`; the review analyzer's own knowledge access resolves it the same way); a task toolset with the same name wins;
- the `agent.instructions` entries for `*` and the task's kind, under `## Team instructions`, first in `context`;
- a knowledge `context` block from `selectForTask` (accepted entries for the repository and task kind, within `agent.tools.knowledgeTokens`, default 1500 tokens; `0` disables it), placed before the task's own `context`;
- external MCP servers from `agent.tools` (`externalServers`: Context7 only with `context7: true`);
- a budget check (`budgetGuard` over `llm.budget`; a `block` limit throws `BudgetExceededError`) and an `onRun({ repo, taskKind, provider, providerKind, model, result | error, durationMs, at, actor?, analyzer?, jobId? })` call after every run, denied ones included. The default `onRun` is `usageRecorder(store.aiUsage)` from [@holtkeeper/ai-usage](../../../packages/ai-usage/docs/README.md); `provider` is the credential's name (or `anthropic`), `model` the provider's model name. `onRun` failures are logged and never change the run's outcome.

Tasks without `taskKind` run as `agent`. `agentFor(repo, { runner, jobId, analyzer, actor })` accepts the job's details; the job engine currently passes only the repository.

## Knowledge

`/api/knowledge` exposes the knowledge base of [@holtkeeper/knowledge](../../../packages/knowledge/docs/README.md):

- `GET /api/knowledge?status=&kind=&topic=&package=&scope=&q=&repo=&limit=` — `status`/`kind` take comma lists; `q` searches (full text, best first, with `score`), otherwise newest first.
- `GET /api/knowledge/:id` — `{ entry, history }`.
- `POST /api/knowledge` — a person's entry (`source: human`, `status` defaults to `accepted`); validated with `validateEntry`, 400 on broken rules.
- `PUT /api/knowledge/:id` — replaces the content and bumps the version; needs write on both the old and the new scope; `version` in the body gives 409 when the entry changed since.
- `POST /api/knowledge/:id/accept|reject|archive` — status changes; accepting an entry that `supersedes` another archives that one (when the caller may write it).
- `DELETE /api/knowledge/:id`.

Changes are logged as `knowledge.created`, `knowledge.updated`, `knowledge.accepted`, `knowledge.rejected`, `knowledge.archived`, `knowledge.removed`.

## AI usage

Agent runs recorded by [@holtkeeper/ai-usage](../../../packages/ai-usage/docs/README.md):

- `GET /api/ai/usage?from=&to=&repo=&group=&model=&provider=&taskKind=&analyzer=&outcome=&groupBy=` — `AiUsageBuckets`: aggregate buckets plus ungrouped totals. `groupBy` is a comma list of `day,week,month,repo,group,model,provider,taskKind,analyzer`; `from` defaults to 30 days ago.
- `GET /api/ai/runs?…&before=&limit=` — `AiRunList`, newest first; `next` is the `before` of the next page. Records carry `jobId` / `analysisId` for links.
- `GET /api/ai/overview` — `AiUsageOverview`: this month vs last month, top 5 repositories, models and task kinds by cost, budget status per visible `llm.budget` entry (spent, limit, %, projected month-end spend), cache hit ratio (cache read tokens over all input tokens) and error rate.

## Jobs and webhooks

With a `jobs` section in the config (see [@holtkeeper/jobs](../../../packages/jobs/docs/README.md)), `startServer` starts a scheduler and a worker (`src/jobs.ts`) and stops them with the server. Pass the analyzers jobs may run as `ServerOptions.analyzers` and an `agentFor(repo)` for analyzers that use an LLM. Finished jobs are written to the activity log (`job.succeeded`, `job.failed`). `GET /api/activity` returns `people` next to the events: name and avatar URL of every user among their actors and subjects, so clients never show bare ids.

Analyzer options per scope come from the setting `analyzers.<kind>` (section `Analyzers`); `analyzerSettings(analyzers)` returns the definitions, with the analyzer's `presets` as setting presets. A value is a partial options object, validated field by field and stored without defaults; it overrides schedule options and is overridden by a manual job's own options.

At startup the server seeds the defaults of a fresh install (`seedDefaultSettings` from [@holtkeeper/settings](../../../packages/settings/docs/README.md#defaults-on-a-fresh-install)) against every setting it knows; `ServerOptions.defaultSettings` replaces the values, `false` turns seeding off. `GET /api/settings` returns each definition's `presets` and `people`: name and avatar of the users among the entries' `updatedBy`, like `/api/activity`.

| Endpoint                      | Does                                                                                                                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/jobs`               | `?status=&repo=forge:path&limit=&before=`, newest first, without logs (`JobList`)                                                                                                |
| `GET /api/jobs/:id`           | one `Job` with its last 200 log lines                                                                                                                                            |
| `POST /api/jobs`              | `CreateJobInput { analyzer, repo?, group?, ref?, options? }`: `repo` for repo-scope analyzers, `group` for group-scope ones; options are validated. 409 without a `jobs` section |
| `POST /api/jobs/:id/cancel`   | cancels a queued or running job; 409 when it already finished                                                                                                                    |
| `POST /api/webhooks/gitlab`   | GitLab webhook, see below                                                                                                                                                        |
| `POST /api/webhooks/r/:token` | one repository's webhook, see [Repository updates](#repository-updates)                                                                                                          |

Group jobs are permission-checked as their group (`{ forge, path: <group>, groups: [<group>] }`).

### GitLab webhook

Point a GitLab project or group webhook at `https://<server>/api/webhooks/gitlab` with the secret token set to `jobs.webhookSecret`, and enable the events you use: "Tag push events", "Merge request events", "Comments". The token is compared in constant time; without `webhookSecret` the endpoint answers 404, a wrong token 401. The server finds the configured `gitlab` forge whose `url` prefixes the project's URL (or the only one). Events that queue nothing are acknowledged with `{ enqueued: [], ignored: <reason> }`; malformed payloads of handled events get 400.

**Tag Push Hook** — queues `jobs.onTag.analyzers` for the repository with `ref` = the tag and trigger `tag`, only when the repository is in one of `onTag.groups`, if given. Group-scope analyzers are queued once per matching group without a ref. Jobs already queued for the same analyzer, repository and ref are skipped. Deleted tags are ignored.

**Merge Request Hook** — queues `jobs.onMergeRequest.analyzers` with options `{ mergeRequest: <iid> }`, `ref` = the head commit (`last_commit.id`) and trigger `webhook` when the merge request is opened, reopened or updated with new commits (`oldrev` present) or out of draft; other updates (title, description, approvals) are ignored. `actions` narrows that to some of `open`, `update`, `reopen`; drafts are skipped unless `draft: true`; `groups` limits repositories. Labels added in the event (`changes.labels`) queue `jobs.onLabel[<label>]`, drafts included. Group-scope analyzers are not queued from merge request events. Closed and merged merge requests are ignored.

**Note Hook** on merge requests:

- `/holtkeeper <command> [args]` on any line queues `jobs.commands[<command>].analyzer` with `{ mergeRequest: <iid>, ...options }` and `ref` = the head commit. Arguments `key=value` set options by name; the others fill the `args` option names in order, the last name taking the rest as a list (`port: { analyzer: 'port', args: ['targets'] }` turns `/holtkeeper port web api` into `targets: ['web', 'api']`). Options are validated against the analyzer before queueing. The server replies in the thread (or on the merge request) with the job id, an error, or the list of commands for an unknown one. Anyone who can comment on the merge request can run commands.
- A reply in a thread Holtkeeper started (first note by `jobs.botUsername` or carrying its marker) queues `review` (or `jobs.commands.review.analyzer`) with `{ mergeRequest, replyTo: <discussion id> }`; the review analyzer answers that thread. This needs the forge's `listDiscussions`.

Events by `jobs.botUsername` and notes carrying Holtkeeper's hidden marker (`<!-- holtkeeper:review ... -->`) are ignored, so the bot never answers itself. Jobs already queued or running for the same analyzer, repository, ref and options are skipped. Activity entries: `job.tag_pushed`, `job.merge_request`, `job.command`, `job.thread_reply`.

```ts
jobs: {
  webhookSecret: env('GITLAB_WEBHOOK_SECRET'),
  botUsername: 'holtkeeper',
  onMergeRequest: { analyzers: ['review'], groups: ['games'] },
  onLabel: { 'needs-port': ['port'] },
  commands: {
    review: { analyzer: 'review' },
    port: { analyzer: 'port', args: ['targets'] },
  },
}
```

### Webhooks per forge

Each forge can have its own webhook: `POST https://<server>/api/webhooks/<forgeId>` with `X-Gitlab-Token` equal to `jobs.webhooks.<forgeId>.secret`. The forge is known from the URL, so no URL matching is needed. Panel forges get the secret from `POST /api/forges/:id/webhook` (below); file forges set `jobs.webhooks` in the config. `POST /api/webhooks/gitlab` with `jobs.webhookSecret` keeps working. URLs are built from `server.publicUrl` (e.g. `https://holtkeeper.example.com`), else from the origin of the request that asks for them.

**Auto-registration.** `POST /api/forges/:id/webhook { register?, targets? }` generates a new secret (32 random bytes, base64url, sealed in the forge document and returned once) and, with `register: true`, registers the hook through the forge's `ensureWebhook` for each target with events tag push, merge request, comments and pipeline. Targets default to the forge's groups: the static prefix of every include glob as a GitLab group (`games/*` → group `games`), exact paths as projects. GitLab group hooks need Premium; on Free (404/403) the adapter registers one project hook per project of the group and the response's `notes` say so. Registration is idempotent by URL: an existing hook with the same URL is updated. Rotating (calling it again) re-registers on the hooks registered before, so GitLab gets the new secret at once; failures per target are in `errors` and do not undo the new secret. Removing the forge removes the hooks it registered.

The forge's token needs scope `api` and the **Maintainer** role (project hooks) or **Owner** role (group hooks) on the targets.

**Pipeline Hook** — for a pipeline of a merge request's head commit that ended `success` or `failed`, the merge request policies run again as an `update` event (the engine loads the latest pipeline fresh), so approvals and merges deferred while the pipeline ran happen now. Only `enqueue` intents queue jobs. Pipelines of other commits are ignored.

### Repository updates

Webhook deliveries are turned into `ForgeEvent`s (`routes/webhooks.ts`) and handled by `createEventDispatcher(deps)` (`events.ts`), which does everything described above. Polling (`updates.ts`) finds the same events and hands them to the same dispatcher, so a repository behaves the same whichever way it learns about a change; jobs queued from polling have trigger `poll` and activity actor `poll`. A job already queued or running for the same analyzer, ref and options is not queued twice, so a change seen both ways runs once.

**Repository webhooks.** Each repository can have its own URL `https://<server>/api/webhooks/r/<token>`. The token (24 random bytes, base64url) is the secret: it is sealed with the vault in `store.kv` (`repo-hook:<forge>:<path>`) so the URL can be shown again, and found by its SHA-256 (`repo-hook-token:<hash>`). Deliveries about another project answer 403, unknown tokens 404; only GitLab payloads are understood for now. Each delivery is recorded as the hook's `lastDelivery`.

**Polling.** A leader duty ticks every 15 s. Repositories are those of the config's groups (listed from the forge, cached for 30 minutes) plus exact repositories the `polling` setting names. For each with `polling` enabled ([@holtkeeper/updates](../../../packages/updates/docs/README.md)):

- The interval is the setting's, or `withWebhook` while any webhook URL reported about the repository in the last 24 hours (`webhook-seen:<forge>:<path>`); `withWebhook: 'off'` stops polling then.
- Repositories are grouped by limiter key (the forge's credential id, `forge:<id>` for file forges). Each key's polling budget is `pollShare` (default 0.2) of its `requestsPerMinute` from `limits.credentials` or the kind defaults; when the repositories of a key ask for more, all of them are slowed by the same factor (`stretch`). A never-polled repository starts at a stable point within its interval.
- Due repositories run one at a time per key, oldest first. A key is skipped while the limiter reports it saturated (cool-down after 429, queue, no free slot) or while the requests spent on it in the last minute would pass its budget; it is tried again next tick.
- State lives in `store.kv` (`poll:<forge>:<path>`: cursor, last poll, requests, events, error, next poll, effective interval and stretch). A lease (`poll-lock:<forge>:<path>`, 2 minutes) keeps two processes from polling one repository at once.

| Endpoint                                  | Does                                                                                                                                                                                                                                          |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/repos/updates?repo=`            | `RepoUpdatesView`: effective `polling` settings and state, `webhookSeenAt`, `viaWebhook`, the repository webhook (its `url` only with `settings:write`)                                                                                       |
| `POST /api/repos/updates/poll`            | `{ repo }`: polls now, whatever the schedule; `RepoPollResult { events?, enqueued?, error?, skipped? }`                                                                                                                                       |
| `POST /api/repos/updates/webhook`         | `{ repo, register? }`: issues or rotates the URL; the previous one stops working. `register` (default: when it was registered) replaces the forge hook through `ensureWebhook` on the project; 502 when that fails (the new URL stays active) |
| `DELETE /api/repos/updates/webhook?repo=` | turns the URL off and removes hooks Holtkeeper registered for it                                                                                                                                                                              |

Reading needs `settings:read` on the repository, the rest `settings:write`. All answer 503 without `store.kv`. Activity: `repo.webhook_created`, `repo.webhook_rotated`, `repo.webhook_removed`.

### Merge request policies

Merge request, note (`/holtkeeper <command>`, as a `command` event) and pipeline events first run the policies of the setting `mergeRequests.policies` (see [@holtkeeper/mr-policies](../../../packages/mr-policies/docs/README.md)) that cover the repository, through the repository's `GitForge`. Every outcome is logged as `mr_policy.<status>` (`done`, `skipped`, `deferred`, `failed`, `intent`, …) with the policy, action and detail; invalid settings entries as `mr_policy.invalid`. The configured analyzers are then queued minus the policies' `skipAnalyzers` (`*` skips all), plus their `enqueue` intents. Done actions are remembered per head commit in `store.kv` (`policy:<engine key>`, 90 days), so a redelivered event does not approve twice. `config.dryRun` evaluates without changing anything. Without policies nothing extra is loaded from the forge.

## Managed configuration

With `store.config`, forges, groups, repository traits, schedules and triggers can be edited in the panel on top of the config file ([@holtkeeper/managed-config](../../../packages/managed-config/docs/README.md) explains precedence and provenance). `deps.config` is a live view of the effective config: routes, the scheduler (which re-reads schedules every tick), the webhook routes and agents always see the current one. The source is rebuilt after every change and once a minute (rotated tokens, limit settings). Panel forges take their token from a stored credential; their clients are cached per document version and token.

| Endpoint                                  | Does                                                                                                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/config/<collection>`            | `ConfigEntryList`: effective entries with `provenance` (`file`, `panel`, `file+panel`) and the panel version. Collections: `forges`, `groups`, `repo-traits`, `schedules`, `triggers` |
| `GET /api/config/<collection>/:id`        | `ConfigEntryDetail`: the entry and earlier versions of its panel document                                                                                                             |
| `PUT /api/config/<collection>/:id`        | creates or replaces the panel document; the whole config is validated first (400 with the problem). Trigger ids are fixed: `tag`, `merge-request`, `label:<label>`, `command:<name>`  |
| `DELETE /api/config/<collection>/:id`     | removes the panel document (the file entry, if any, applies again); 409 when the rest would become invalid                                                                            |
| `POST /api/forges/:id/webhook`            | generates or rotates the webhook secret, optionally registers the hook (see above)                                                                                                    |
| `POST /api/forges/:id/ssh-key`            | issues or rotates the forge's SSH key (see below)                                                                                                                                     |
| `DELETE /api/forges/:id/ssh-key`          | removes the key from the forge account and deletes its credential                                                                                                                     |
| `GET /api/config/export`                  | the effective config as `holtkeeper.config.ts` source, secrets as `env()` placeholders                                                                                                |
| `GET /api/schedules/:id/preview?count=10` | `SchedulePreview`: the next run times (smart schedules: windows, zone, jitter)                                                                                                        |

Every change is logged: `config.<type>.created|updated|removed`, `config.forge.webhook_created|webhook_rotated`, subject `<type>:<id>`.

### Forge SSH keys

A panel forge can issue an SSH key on the account behind its token (`POST /api/forges/:id/ssh-key { usage?, expiresInDays?, identity? }`, global `settings:write`; file forges answer 409). The server generates an Ed25519 key, registers it as a user key (`usage` default `auth_and_signing`, expiry default 365 days), pins the forge host's SSH keys with `ssh-keyscan` (trust on first use; a failure is a note and git stays on HTTPS), reads the commit identity from `getCurrentUser` unless `identity` is given, and stores the key as an `ssh` credential with the token credential's scope. The forge document keeps only the credential id; the forge entry of `GET /api/config/forges` shows `sshKey` (public key, fingerprint, usage, expiry, identity, whether host keys are pinned), never the private key. Calling it again rotates the key in place (`rotateSshKey`: the new key is registered and stored before the old one is removed). Deleting the key or the forge removes the registration and the credential.

Jobs use the key through `gitKeyFor` (see [@holtkeeper/jobs](../../../packages/jobs/docs/README.md#context)): clone, fetch and push over SSH, signed commits for propagate and port. Running git over SSH and signing needs `ssh`, `ssh-keyscan` and `ssh-keygen` on the host (`openssh-client` in the worker image).

## Roles, health and metrics

`startServer(config, { roles, worker, drainTimeoutMs })` runs what `roles` asks for (`roles.ts`, default `['all']`): `web` serves the API, UI and webhooks; `worker` runs the job worker; `scheduler` runs schedules, credential rotation, artifact and audit retention, only while this process holds the leader lease (`leader.ts`: `kv.acquireLease` on `leader:scheduler`, 30 s TTL, renewed every 10 s; a failed renewal stops the duties). Processes without `web` serve only the operational endpoints. `worker: { concurrency?, maxJobs? }` overrides `jobs.concurrency` and makes the worker stop after `maxJobs` jobs; `RunningServer.exhausted` then resolves.

Every process answers `GET /healthz` (alive), `GET /readyz` (store query, Postgres migrations via `ready()`, artifact store listing, not draining; 503 with a JSON body per check otherwise) and `GET /metrics` (Prometheus text: queue gauges, finished jobs and a duration histogram by analyzer, webhook deliveries by forge and status, AI runs/tokens/cost, limiter saturation per key, artifact store bytes; `metrics.ts`). They bypass authentication. `stop()` drains: readiness fails, the worker stops claiming and running jobs get `drainTimeoutMs` (30 s) before they are requeued, then the lease is released and the store closed.

With `limits: { distributed: true }` the limiter keeps its counters in the store's `kv` (`limiter-state.ts`, `storeLimiterState` from `@holtkeeper/limits`). See [docs/deployment.md](../../../docs/deployment.md) for Docker and Kubernetes.

## Limits

One `@holtkeeper/limits` limiter is shared by the server (`deps.limiter`): GitLab requests of panel forges count against their credential id, those of file forges against `forge:<id>` (kind defaults, overridden by the everything-scope entry of the setting `limits.credentials`); the job worker's admission hook leaves jobs waiting while their forge key or, for analyzers that use an agent, their AI provider key (`llm.provider` credential id, else `ai:anthropic`) is saturated. The agent factory gets the same limiter.

## Feeding audits

`holtkeeper audit <dir> --upload http://localhost:7420 --repo work:games/slots-x` posts a report as the current CLI user. Machine credentials (API tokens) for CI are not implemented yet; until then CI uploads work with `noAuth` or `headerAuth` behind a proxy that authenticates CI.

## Artifacts

Generated files live in an `ArtifactStore` (`@holtkeeper/artifacts`), `ServerDeps.artifacts`, built by `artifactStoreFor(config.server)`. Without one the artifact and media routes answer 503.

| Endpoint                  | Does                                                                                                                                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/artifacts/:id`  | Download. Stores with `presign` (S3) redirect (302) to a URL valid for 5 minutes; others stream with the stored content type, `Content-Disposition: attachment` with the artifact's name, `nosniff` and a sandbox CSP. |
| `POST /api/artifacts/zip` | `ArtifactZipInput { files: { id, path }[], name? }` → `application/zip`; paths must be relative without `..`; at most 500 files and 512 MB.                                                                            |

`POST /api/analyses` accepts `artifacts: { id, base64, contentType?, name? }[]` next to `data`; every id must equal the SHA-256 of its decoded content (400 otherwise). They are stored with tags `{ repo, kind, analysis }`. Accepting changes (`POST /api/analyses/:id/changes`) resolves `artifact` references of `write-binary` edits from the store; in `patch` mode binary files are listed in a trailing comment of the patch instead of diffed.

## Media

Responsive image variants and SVG optimization for files in repositories, behind a small `MediaEngine` interface (`src/media/engine.ts`). `src/media/adapter.ts` maps it to `@holtkeeper/media` (sharp, svgo), imported on first use; it probes the image (rejecting more than `maxPixels` from the header), plans and encodes variants (`formats`, `widths`, `quality`; `densities` give a texture-style `@Nx` ladder; preset `fast`/`default`/`max` sets encoder effort), optimizes SVGs with svgo's `safe` preset and renders snippets for every framework. Tests pass a fake engine as `ServerDeps.media`.

Merge request reviews use `createMediaReviewer({ publicUrl })` (`src/media/reviewer.ts`) as the review analyzer's `mediaReviewer`: per changed raster image a savings table (original against AVIF/WebP/re-encoded, typical transfer at 375/768/1440 CSS px at DPR 2), a `<picture>` suggestion on added `<img>` usage lines, a whole-file svgo suggestion for added SVGs (otherwise a summary line), and links to `${publicUrl}/media?repo=…&file=…&ref=…`.

Artifacts returned by analyzer runs in background jobs (e.g. the encoded variants of `assets`) are stored in the artifact store tagged `{ repo, kind, analysis }` (`persistArtifactsTo`); CLI uploads send them in `artifacts` of `POST /api/analyses`.

`POST /api/media/variants` — `MediaVariantsInput { repo: 'forge:path', file, ref?, formats?, widths?, densities?, quality?, preset? }`. Reads the original with `forge.readFileBytes` (SVG through `readFile`), runs the engine and stores each variant (or the optimized SVG) as an artifact tagged `{ repo, kind: 'media', source }`. Returns `MediaVariantsResult { original, variants: { id, format, width, height, quality, bytes, savingsPercent, path }[], svg?, snippets, savings }`; `path` is the engine's suggestion or `<dir>/<name>-<width>w.<format>`, `savings` the smallest variant per format against the original.

- Limits (`MediaLimits`): originals up to 25 MB and 50 megapixels (the engine rejects bigger images before decoding them fully; 413), two images processed at once, eight more waiting, then 429. Engine failures are 422.
- Results are cached in memory by (SHA-256 of the original, options), 100 entries, and recomputed when one of their artifacts is gone.

`POST /api/media/apply` — `MediaApplyInput { repo, file, ref?, variants: id[], paths?: { [id]: path }, replaceOriginal?: id, snippet?: { file, range, oldText, newText }, mode, title? }`.

- `merge-request`: one `CodeChange` with a `write-binary` edit per variant (new files; a conflict when the path exists), one replacing `file` when `replaceOriginal` is given (guarded by the current file's SHA-256), and the snippet as a `replace` edit; opened with `openMergeRequest` against `ref` or the default branch. Returns `MediaApplyResult { applied, conflicts, mergeRequest? }` and logs `media.merge_request_opened`.
- `zip`: an `application/zip` download with the files at their paths and a `README.md` holding the snippet.

## Storage

`GET /api/storage` returns `StorageOverview { providers: { id, label, bytes, count?, details, available, note?, clearable, error? }[], totalBytes }` from `ServerDeps.storage` (`StorageProvider`s). `startServer` registers the artifact store (`artifactStorage`) and the database (`databaseStorage(server.databasePath)`: the SQLite file plus `-wal`/`-shm`), plus `ServerOptions.storage` — pass `mirrorStorage(jobs.cacheDir)` from `@holtkeeper/workspace` and `miseCacheStorage(...)` from `@holtkeeper/exec-container` there. `POST /api/storage/:id/clear { scope? }` calls the provider's `clear` (409 when it has none, 400 for a bad scope) and logs `storage.cleared`.

## Audit log

Every mutating request (`POST`, `PUT`, `PATCH`, `DELETE`) under `/api` and `/auth/<provider>/admin` is appended to `store.audit` once its response is ready, whatever the outcome: actor (or `anonymous`), `via` (`webhook` for `/api/webhooks/*`; `ui` when the browser sent `Sec-Fetch-Site`, else `api`), the route template and params, status, duration, client IP (`X-Forwarded-For`, `X-Real-IP`, else the socket) and user agent. 401 and 403 are `denied`, other 4xx/5xx `error`. The action and target are derived from the route (`PATCH /api/credentials/:id` → `credential.update` on `credential:<id>`, `POST /api/credentials/:id/rotate` → `credential.rotate`); `?repo=` becomes `target.repo`. Reads are not audited, except `audit.export`.

Routes enrich their event with `c.set('audit', { action?, target?, changes?, details? })`. Credentials, settings and knowledge record field-level `changes` (`diffChanges(before, after)`: dotted paths, arrays compared whole); fields named like secrets (`secret`, `password`, `token`, `apiKey`, `authorization`, ...) and the values of secret settings are `«redacted»`, and a new credential secret is recorded only as changed. User changes made through the `users` provider (`PATCH /auth/users/admin/users/:id`) get `changes` from the stored user before and after.

Background code appends with `appendAudit(store, event)` from `src/audit.ts`:

```ts
appendAudit(store: Pick<Store, 'audit'>, event: Omit<AuditEventInput, 'at'> & { at?: Timestamp }): Promise<AuditEvent | undefined>

await appendAudit(deps.store, {
  actor: { id: 'gitlab:work:42', name: 'jane', provider: 'gitlab:work' },
  via: 'webhook', // or 'job' / 'system'
  action: 'mr.policy.label',
  target: { type: 'merge-request', id: '17', repo: 'work:games/slots' },
  outcome: 'ok',
  details: { label: 'needs-review' },
})
```

It never throws (failures are logged) and does nothing when the store has no audit log.

| Endpoint                                   | Result                                                                                                         |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `GET /api/audit`                           | `AuditList` `{ events, nextCursor? }`, newest first; `cursor`, `limit` (≤ 500) and the filters below           |
| `GET /api/audit/count`                     | `{ count }` for the filters                                                                                    |
| `GET /api/audit/export?format=csv\|ndjson` | streamed download, oldest first (default `ndjson`); itself audited as `audit.export`                           |
| `GET /api/audit/verify?fromSeq=&toSeq=`    | `AuditVerification` of the hash chain (see the [store docs](../../../packages/store/docs/README.md#audit-log)) |

Filters: `actor`, `action` (prefix), `targetType`, `targetId`, `repo` (`forge:path`), `outcome`, `via`, `from`, `to`. Retention: `startServer(config, { auditRetentionDays })` sweeps daily, default 365 days, `0` keeps everything.

## Avatars

`GET /api/avatars/<seed>.svg?size=` (16–512, default 128) renders the [DiceBear](https://www.dicebear.com) **Voxel Bot** style locally with `@dicebear/core` from the definition in `@dicebear/styles` — no request leaves the server. The style is by DiceBear and licensed [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). Responses are `Cache-Control: public, max-age=31536000, immutable` with a content ETag (`If-None-Match` → 304) and a CSP that forbids scripts; recent renders are cached in memory.

The seed is the principal id (users: the user id). `GET /api/me` and `UserView` carry `avatarUrl` (`/api/avatars/<id>.svg`). `users` accounts may reroll with `PUT /api/me/avatar { seed }` (`null` goes back to the id); other providers answer 409.

## External accounts

The caller's own links, served by [@holtkeeper/identities](../../../packages/identities/docs/README.md):

| Endpoint                           | Result                                                                              |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| `GET /api/accounts`                | `ExternalAccountList` (challenge hashes never leave the server)                     |
| `POST /api/accounts`               | 201 `ExternalAccountView`, `unverified`; body `{ provider, externalId, username? }` |
| `DELETE /api/accounts/:id`         | 204                                                                                 |
| `POST /api/accounts/:id/challenge` | 201 `AccountChallenge` `{ code, expiresAt, command }`, shown once                   |

Admins link verified accounts under `/auth/users/admin/users/:id/accounts` (see [@holtkeeper/auth-users](../../../packages/auth-users/docs/README.md)). Webhooks and bots use `identitiesFor(deps)` from `src/routes/accounts.ts` for `completeChallenge`, `resolveExternalActor` and `authorizeExternal`. 503 when the store keeps no external accounts.
