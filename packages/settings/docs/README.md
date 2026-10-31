# @holtkeeper/settings

Settings that differ per group of projects: which model and API key agents use, audit policy, review rules. Each setting key can have entries for several scopes; the most specific one covering a repository wins.

## Definitions

```ts
defineSetting({
  key: 'llm.model',
  label: 'Model',
  description: '...',
  section: 'AI',
  schema: z.string().min(1),
  secret?: true, // sealed in storage, never sent to clients
})
```

Built in: `llm.provider` (the id or name of an AI provider credential, see [@holtkeeper/agent](../../agent/docs/README.md#providers); its schema carries `"x-credential": "ai-provider"` so the UI offers a credential picker; `"x-credential": "github"` offers credentials of kind `github`, any other family every credential), `llm.model`, `llm.models`, `agent.tools` (`context7`, `maxResultLines`, `knowledgeTokens`), `agent.instructions` (Markdown rules by task kind, `*` for every task), `llm.budget` (see [@holtkeeper/ai-usage](../../ai-usage/docs/README.md)), `review.instructions`, `knowledge.autoAccept` (knowledge kinds agent proposals are accepted for without review, see [@holtkeeper/knowledge](../../knowledge/docs/README.md)), `audit.fix`, `audit.upgrade`, `audit.allowlist`, `repo.readOnly` (boolean, section `Repositories`: Holtkeeper only analyzes the repository and never changes it, see [@holtkeeper/server](../../../apps/server/docs/README.md#read-only-repositories)). Plugins add their own; the server validates values against the schema and exposes it as JSON Schema so the UI can build forms. When `schema` cannot describe the shape (a refined record that checks fields one by one, like `analyzers.<kind>`), `form` gives the shape shown to editors instead. `help` is optional Markdown guidance the panel shows next to the setting and its editor: what it changes, how its scopes combine and recommended values; `description` stays the one-line summary. A schema (or `form`) carrying `"x-editor": "<name>"` asks the panel for a dedicated editor instead of the generated form; The panel ships `merge-request-policies` and `trackers`.

`presets` lists ready-made values (`{ id, label, description?, value }`, each passing `schema`) that the panel offers in a **Preset** picker. Applied to an object value a preset sets its own fields and keeps the others, so partial presets combine; other values are replaced. Built in: `llm.models` (`balanced`, `economy`, `quality`) and `llm.budget` (`learn`, `small-team`, `team`). Analyzers declare theirs as `Analyzer.presets` (options instead of `value`), which `analyzerSettings` turns into presets of `analyzers.<kind>`, e.g. the license policies of [@holtkeeper/licenses](../../licenses/docs/README.md#presets).

## Defaults on a fresh install

`seedDefaultSettings({ store, definitions, defaults?, now? })` writes `defaults` (default `defaultSettings`) for `{ all: true }` when the store holds no settings at all, and only once per store: the first call records `settings:defaults-seeded` in `Store.kv` (atomically through `compareAndSet`, so concurrent servers seed once), and later calls do nothing, even after every setting was removed. A store that already has settings is marked and left alone. Without `kv` the empty store is the only check; entry ids are stable (`default:<key>`), so concurrent seeding writes the same entries. Unknown keys, secret settings and values their schema rejects are skipped. Entries are `updatedBy: 'system'` and the run is logged as the activity `settings.seeded` with `details.keys`. The server calls it at startup.

| Key                    | Default                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `llm.model`            | `claude-opus@latest`                                                                                                                                          |
| `llm.models`           | preset `balanced`: Opus for `review`, `port`, `refactor`; Sonnet for `propagate`, `tests`, `quality`, `release-risk`; Haiku for `triage` and `library-digest` |
| `llm.budget`           | preset `learn`: `warn` above $300 a month or $30 a day                                                                                                        |
| `agent.tools`          | `context7: false`, `maxResultLines: 200`, `knowledgeTokens: 1500`                                                                                             |
| `knowledge.autoAccept` | `quirk`, `howto`                                                                                                                                              |
| `audit.upgrade`        | `minor`                                                                                                                                                       |
| `polling`              | `enabled`, every `5m`, `1h` while webhooks deliver (`defaultPolling` of [@holtkeeper/updates](../../updates/docs/README.md#setting), added by the server)     |

The model references assume an Anthropic provider; with another one, change `llm.model` and `llm.models` together with `llm.provider`.

`defaultTaskModels` names models for task kinds that suit a small model whatever `llm.model` is: `library-digest` (issue thread summaries of the library docs) → `claude-haiku@latest`. The server uses one only when `llm.models` and the provider's options have no entry for the kind and the provider lists the model; otherwise the kind runs on `llm.model`. Every `llm.models` preset sets `library-digest` explicitly.

## Resolution

`resolveSetting(entries, key, repo)` picks, among entries whose scope covers the repository, the most specific:

1. exact repository paths (`games/app-x`)
2. path globs (`games/app-*`)
3. group intersections (`[['frontend', 'storefront']]`), more groups first
4. groups (`games`)
5. everything

Ties go to the most recently updated entry. The ranking is `scopeSpecificity` of [@holtkeeper/access](../../access/docs/README.md), shared with merge request policies, knowledge and AI budgets. `resolveSettings(entries, repo)` resolves every key at once; the API exposes it as `GET /api/settings/resolve?repo=forge:path`.
