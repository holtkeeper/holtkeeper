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

Built in: `llm.provider` (the id or name of an AI provider credential, see [@holtkeeper/agent](../../agent/docs/README.md#providers); the legacy value `anthropic` means "Anthropic API with `llm.apiKey`"), `llm.model`, `llm.apiKey` (secret), `llm.models`, `agent.tools` (`context7`, `maxResultLines`, `knowledgeTokens`), `llm.budget` (see [@holtkeeper/ai-usage](../../ai-usage/docs/README.md)), `review.instructions`, `audit.fix`, `audit.upgrade`, `audit.allowlist`. Plugins add their own; the server validates values against the schema and exposes it as JSON Schema so the UI can build forms.

## Resolution

`resolveSetting(entries, key, repo)` picks, among entries whose scope covers the repository, the most specific:

1. exact repository paths (`games/slots-x`)
2. path globs (`games/slots-*`)
3. groups (`games`)
4. everything

Ties go to the most recently updated entry. `resolveSettings(entries, repo)` resolves every key at once; the API exposes it as `GET /api/settings/resolve?repo=forge:path`.
