# @holtkeeper/settings

Settings that differ per group of projects: audit policy, AI budgets, plus a few global ones such as the AI provider agents use. Each setting key can have entries for several scopes; the most specific one covering a repository wins.

## Definitions

```ts
defineSetting({
  key: 'audit.upgrade',
  label: 'Largest upgrade',
  description: '...',
  section: 'Audit',
  schema: z.enum(['major', 'minor', 'patch']),
  default: 'major', // what applies where no entry covers a repository; null when nothing does
  secret?: true, // sealed in storage, never sent to clients
  global?: true, // one value for every repository: only `{ all: true }` entries
})
```

Built in: `llm.provider` (global; the id or name of an AI provider credential, see [@holtkeeper/agent](../../agent/docs/README.md#providers); its schema carries `"x-credential": "ai-provider"` so the UI offers a credential picker; `"x-credential": "github"` offers credentials of kind `github`, any other family every credential; there is no model setting: tasks run on the fixed tiers of `@holtkeeper/agent`), `agent.tools` (`knowledgeTokens`: how much of a task's Guide knowledge notes may take), `llm.budget` (see [@holtkeeper/ai-usage](../../ai-usage/docs/README.md)), `knowledge.autoAccept` (knowledge kinds agent proposals are accepted for without review, see [@holtkeeper/knowledge](../../knowledge/docs/README.md)), `audit.fix`, `audit.upgrade`, `audit.allowlist`, `audit.allowlistPolicy` (`allowlistPolicySchema`: `maxDays` (optional, 1–3650: new and renewed allowlist entries must expire within that many days) and `requireReason` (default `true`); the default `{ requireReason: true }` sets no expiry cap; whoever writes allowlist entries enforces it), `repo.freeze` (section `Repositories`, `repoFreezeSchema` `{ reason, until? }`: Holtkeeper only analyzes the repository and never changes it, see [@holtkeeper/server](../../../apps/server/docs/README.md#read-only-repositories); see [Freezes](#freezes)), `access.crossTeam` (label **Reach**, global, section `Access`: `off`, `metadata` or `snippets`, default `defaultCrossTeam` = `snippets`; how far people and agents read other teams' catalog, one level for everyone with no per-team exceptions; the schema carries `"x-labels"` with a plain label per level; see [@holtkeeper/server](../../../apps/server/docs/README.md#cross-team-catalog)), `tasks.write` (global, section `AI`, edited in the panel's Ops › Tasks, `tasksWriteSchema`: `enabled` (default `false`, the instance-wide switch for [write tasks](../../write-task/docs/README.md)), `perRepoUsd` 1.5, `perGroupUsd` 5, `weeklyUsd` 40, `maxRepos` 10). The server also registers `commits.conventions` (see [@holtkeeper/commit-conventions](../../commit-conventions/docs/README.md)). Every definition has a `default`: the value the code reading the setting uses when no entry covers a repository, typed as the schema's output, or `null` when nothing applies until someone sets it (`llm.provider`). It describes behavior without an entry and is never written to the store; values a fresh install starts with are `defaultSettings` below. `analyzerSettings` fills it for `analyzers.<kind>` with what the options schema fills in by itself. Plugins add their own; the server validates values against the schema and exposes it as JSON Schema so the UI can build forms. A `global` setting accepts only entries for `{ all: true }`: the server refuses other scopes and the panel offers no scope picker for it. When `schema` cannot describe the shape (a refined record that checks fields one by one, like `analyzers.<kind>`), `form` gives the shape shown to editors instead. `help` is optional Markdown guidance the panel shows next to the setting and its editor: what it changes, how its scopes combine and recommended values; `description` stays the one-line summary. A schema (or `form`) carrying `"x-editor": "<name>"` asks the panel for a dedicated editor instead of the generated form; The panel ships `merge-request-policies`, `trackers` and `renovate`. Analyzers name theirs with `Analyzer.editor`, which the server puts on the `analyzers.<kind>` form.

`presets` lists ready-made values (`{ id, label, description?, value }`, each passing `schema`) that the panel offers in a **Preset** picker. Applied to an object value a preset sets its own fields and keeps the others, so partial presets combine; other values are replaced. Built in: `llm.budget` (`default`, `learn`, `small-team`). Analyzers declare theirs as `Analyzer.presets` (options instead of `value`), which `analyzerSettings` turns into presets of `analyzers.<kind>`, e.g. the license policies of [@holtkeeper/licenses](../../licenses/docs/README.md#presets).

## Defaults on a fresh install

`seedDefaultSettings({ store, definitions, defaults?, now? })` writes `defaults` (default `defaultSettings`) for `{ all: true }` when the store holds no settings at all, and only once per store: the first call records `settings:defaults-seeded` in `Store.kv` (atomically through `compareAndSet`, so concurrent servers seed once), and later calls do nothing, even after every setting was removed. A store that already has settings is marked and left alone. Without `kv` the empty store is the only check; entry ids are stable (`default:<key>`), so concurrent seeding writes the same entries. Unknown keys, secret settings and values their schema rejects are skipped. Entries are `updatedBy: 'system'` and the run is audited as `setting.seed` by the system actor with `details.keys`. The server calls it at startup.

| Key                    | Default                                                                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `llm.budget`           | preset `default`: `block` above $150 a week, the last $25 kept for interactive work                                                                       |
| `agent.tools`          | `knowledgeTokens: 1500`                                                                                                                                   |
| `knowledge.autoAccept` | `quirk`, `howto`                                                                                                                                          |
| `audit.upgrade`        | `minor`                                                                                                                                                   |
| `polling`              | `enabled`, every `5m`, `1h` while webhooks deliver (`defaultPolling` of [@holtkeeper/updates](../../updates/docs/README.md#setting), added by the server) |

## Freezes

`repo.freeze` values are `{ reason, until? }`: `reason` is required (1–500 characters after trimming), `until` an ISO 8601 date-time with offset; without it the freeze lasts until the entry is removed. `activeFreeze(value, now?)` returns the value while it is in force (valid and `now` before `until`), `resolveRepoFreeze(entries, repo, now?)` the `{ entry, freeze }` in force for a repository: the most specific covering entry among those not past their end, so an expired entry is ignored and a broader one applies again. A narrower entry cannot lift a broader freeze. Every reader of the setting goes through these helpers, so a freeze counts only before `until`.

## Retired keys

`retiredSettingKeys` lists keys Holtkeeper no longer reads: the old model settings (`llm.model`, `llm.models`), prose instructions that moved to the Guide (`review.instructions`, `agent.instructions`) the options of removed analyzers (`analyzers.changelog`, `analyzers.delivery`, `analyzers.fleet`, `analyzers.port`, `analyzers.quality`, `analyzers.release-risk`, `analyzers.warmup`) and the boolean `repo.readOnly`, replaced by `repo.freeze` (stored values are not converted: set them again as freezes). `isRetiredSetting(key)` checks one. The resolvers below return nothing for them, and the server hides their definitions and stored entries and refuses new values, so stored rows with values no schema accepts never break validation. The rows stay in the store until a one-off cleanup removes them; never reuse a retired key for a new setting.

## Resolution

`resolveSetting(entries, key, repo)` picks, among entries whose scope covers the repository, the most specific:

1. exact repository paths (`games/app-x`)
2. path globs (`games/app-*`)
3. group intersections (`[['frontend', 'storefront']]`), more groups first
4. groups (`games`)
5. everything

Ties go to the most recently updated entry; retired keys never resolve. The ranking is `scopeSpecificity` of [@holtkeeper/access](../../access/docs/README.md), shared with merge request policies, knowledge and AI budgets. `resolveSettings(entries, repo)` resolves every key at once. `settingCascade(entries, key, repo)` lists every covering entry in override order (the one that applies first, then the ones it overrides from narrow to broad) and `settingCascades(entries, repo)` does that for every key with a covering entry; the API exposes both as `GET /api/settings/resolve?repo=forge:path` (`settings` with the winners, `cascade` with the full lists).

`effectiveSettings(definitions, entries, repo)` gives one row per definition, in order and without retired keys: the single entry that applies as a whole (`entry`, absent when `definition.default` applies) and the covering entries it overrides (`overridden`, narrow to broad). Values are never merged field by field, a `global` definition counts only entries scoped `{ all: true }`, and entries of keys without a definition are ignored. It backs the resolver rows of `GET /api/settings/resolve`.

Team rules for review and agents are not settings: they live in the [Guide](../../guide/docs/README.md).
