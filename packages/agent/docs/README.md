# @holtkeeper/agent

The `Agent` contract for LLM work on a repository checkout (code review, refactoring, writing tests), its Claude implementation on the [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview), the primary loop for agentic tasks with tools, a [Vercel AI SDK](https://ai-sdk.dev) implementation for one-shots, fallback tool loops and every other provider, fixed model tiers, run transcripts, and `createAgent`, which builds an agent from an AI provider credential and routes each task to a loop. Callers depend on `Agent` only and ask for a tier, never a model; the provider is configuration.

## Contract

- `Agent { name; run(task) }` — runs one task in `task.dir` and resolves with `AgentResult { text, output?, turns, costUsd?, usage?, model?, runtime?, transcriptRef? }` (`model`: the provider's model id the run used, set by the shipped adapters; `runtime`: `claude-sdk` or `ai-sdk`; `transcriptRef`: where a caller stored the run's transcript); `usage` is `{ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }`.
- `AgentTask` — `dir`, `prompt`, optional `system`, `capabilities` (default `['read', 'search']`), `output` (a zod schema the answer must match), `maxTurns`, `maxCostUsd` (the run's spend cap: the AI SDK adapter stops its tool loop after the step that reaches it, pricing a model `pricing` does not know at a conservative fallback (Opus-level prices) so the cap and budgets still hold, the Claude adapter passes it as `maxBudgetUsd`; either way the run fails with `BudgetExceededError` carrying what it used), `estimateUsd` (the expected cost the budget check weighs before the run starts; adapters ignore it), `signal`, and:
  - `tier` — `fast`, `main` (default) or `deep`, see [Model tiers](#model-tiers); the adapter runs the tier's model at its reasoning effort.
  - `taskKind` — `review`, `refactor`, `triage`, ...; for knowledge, instructions and reporting, never for the model.
  - `context` — a pre-selected knowledge/conventions block, placed early in the system prompt.
  - `toolsets` — in-process tools (`Toolset { name; tools: AgentTool[]; instructions? }`), e.g. from `@holtkeeper/agent-tools`. Both adapters add every toolset's `instructions` (when to use its tools) to the system prompt as a "When to use the tool groups" list.
  - `mcpServers` — external MCP servers by name (SDK `McpServerConfig`).
  - `transcript` — a `TranscriptSink` that receives the run's events, see [Transcripts](#transcripts).
  - `followUpWithoutTools` — a follow-up for shallow answers: when the final answer comes before any tool call, the AI SDK loop sends this text once as the next user message in the same conversation and returns the answer to it (the first answer stays the result when the follow-up gives no valid one); skipped at the turn limit or cost cap, and when the task mounts no tools. The Claude adapter ignores it. The review uses it for non-trivial diffs.
  - `commands` — with `run`: the only commands the agent may run (`commandAllowed(command, commands)`: the command's words start with the words of one entry, so `bun run test` also allows `bun run test src/widget.test.ts`; shell operators, substitutions, redirections, line breaks and quotes are refused). The Claude adapter denies other `Bash` calls in its permission gate, the AI SDK adapter's `run_command` refuses them. Absent: any command.
  - `env` — variables for the agent's commands (the egress proxy, ...), on top of the adapter's minimal environment; the Claude adapter passes them to Claude Code (its own provider variables win), the AI SDK adapter to `run_command`. Never secrets.
- `AgentCapability` — `read`, `search`, `run`, `edit`.
- `AgentTool { name; description; input: z.ZodObject; run(input, { dir, signal }) → string }` — returns compact text within its own output budget; a thrown error is reported to the model, not to the caller.
- `BudgetExceededError { httpStatus?, code?, usage?, costUsd?, turns? }` — a spend limit stopped the run. Every adapter fails a run with it when the run reaches `maxCostUsd` (with the usage so far) or the provider or gateway refuses over a spent limit (HTTP 402, a budget code such as `insufficient_funds`, `api_key_limit_exceeded` or `insufficient_quota`, or a 400/403/429 that speaks of a spend limit, budget or credit balance), so callers can tell it from rate limits and other errors; a retry does not help until the limit resets. `budgetExceededFrom(error)` applies the same rules to any error (AI SDK `APICallError`/`RetryError` included) and returns `undefined` for anything else.
- `MaxTurnsError { usage, costUsd?, turns }` — the AI SDK tool loop reached its turn limit and the final tool-less request gave no usable answer; it carries what the run used, so usage records and budgets count it.

## Model tiers

| Tier   | Model                | Effort   | Used for                                                               |
| ------ | -------------------- | -------- | ---------------------------------------------------------------------- |
| `fast` | newest Claude Haiku  | `low`    | summaries, release notes, classification (review re-checks), one-shots |
| `main` | newest Claude Sonnet | `medium` | reviews, thread replies, chat, write tasks; the default                |
| `deep` | newest Claude Opus   | `high`   | reviews whose `depth` setting asks for `deep`                          |

`TIERS` holds each tier's `family`, `effort` and `fallback` id (`claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`); `MODEL_TIERS`, `DEFAULT_TIER` (`main`), `FALLBACK_TIER_MODELS`. `resolveTierModels(listing)` turns a provider's model listing into `TierModels` (`{ fast, main, deep }`) with `resolveLatestModel('<family>@latest', models)`, so vendor-prefixed and dotted ids of routers (`vendor/claude-sonnet-5.5`) match. When the listing failed or is empty every unmatched tier takes its fallback; when the provider listed models but none of a tier's family, that tier runs on the nearest tier that has one (deep → main → fast, fast → main → deep, main → deep → fast) and `resolveTierModels(listing, { log })` reports it; it throws only when no Claude family is listed at all, and then the server builds no agent. Effort goes to the Claude Agent SDK as `effort` and to the AI SDK as `reasoning`; providers without effort support ignore it.

## Runtime routing

`createAgent` picks a loop per task with `runtimeFor(kind, task, agentLoop)`:

| Credential kind                     | Tool-loop task (`needsToolLoop`)                                                      | One-shot                      |
| ----------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------- |
| `anthropic`, `anthropic-compatible` | Claude Agent SDK; the AI SDK loop on `@ai-sdk/anthropic` when `agentLoop` is `failed` | AI SDK on `@ai-sdk/anthropic` |
| `ai-sdk`                            | AI SDK loop through its package                                                       | AI SDK through its package    |

- `needsToolLoop(task)` is true when the task may touch the checkout (any capability; none given means the default `read` and `search`), or mounts a toolset with tools or an MCP server. `capabilities: []` without toolsets is a one-shot.
- `agentLoop` (`CreateAgentOptions.agentLoop`, `AgentLoopStatus`: `ok`, `failed`, `unknown`) is the stored result of the credential's probe; `unknown` (never probed) counts as working for the Anthropic kinds. Whether the Claude Agent SDK works through a gateway (tool use, streaming, `cache_control`) is a property of the gateway, so the probe decides instead of configuration.
- The AI SDK side of an Anthropic kind (`anthropicMessagesConnection`) talks to the same Messages root Claude Code gets (`<root>/v1`, a trailing `/v1` in the URL is tolerated), with the same auth (`x-api-key`, or `authToken` for bearer) and rendered headers. Only the AI SDK side uses `CreateAgentOptions.pricing` (e.g. catalog prices) for Anthropic kinds; the Claude side keeps the SDK's reported cost unless the credential's own `pricing` names the model.
- `ProviderAgent.runtimeFor(task)` tells which loop a task would take.

### Probing a gateway

`probeAgentLoop(provider, model, { fetch?, signal? })` sends one tiny Messages request (`max_tokens` 128) with one tool, a cache breakpoint on the system prompt and `tool_choice: auto` (Claude 5.5 models refuse forced tool use) to `<root>/v1/messages`, the way Claude Code talks to it, and resolves `{ status: 'ok' | 'failed', model, latencyMs, error?, conclusive }`: `ok` when the answer calls the tool; `failed` with the reason (HTTP status and the gateway's message, a timeout, a non-Messages answer, an answer without the tool call), the secret redacted. `conclusive` is true only when the answer decides it (a successful answer, or a 400 that rejects the request); a transport error, timeout, 401/403, 429 or 5xx says nothing about the loop. `model` is logical (`modelMap` applies). It throws only for `ai-sdk` providers. The server runs it as the credential test and stores the outcome.

## Transcripts

Every adapter writes the events of a run to `task.transcript` (`TranscriptSink { write(entry) }`) as `TranscriptEntry`s:

- `start` — `runtime`, `model`, `tier`, `taskKind?`, `tools` (names), `system?` (the appended system prompt), `prompt`;
- `assistant` — model `reasoning?` (cut like tool results), `text?` and `toolCalls?` (`{ id, name, input }`);
- `tool-result` — `id`, `name?`, `output`, `isError?`;
- `end` — `outcome` (`ok` or `error`), `turns?`, `usage?`, `costUsd?`, `error?`.

Adapters never write their SDK options, the process environment or secrets. `createAgent` wraps the sink with `redactingSink(sink, secrets)`, which replaces the provider secret and rendered header values. `createTranscript({ secrets?, limit?, now? })` keeps lines in memory, stamped with `at`, sanitized on write (`sanitizeEntry`: given secrets and well-known token shapes such as `sk-ant-…`, `glpat-…`, `ghp_…`, AWS key ids, `Bearer …` and private keys become `[redacted]`; tool results and string arguments of tool calls are cut at `TRANSCRIPT_TEXT_LIMIT`, 4000 characters; prompts stay whole) and serializes them with `toJsonl()`. `parseTranscript(jsonl)` reads lines back and skips malformed ones; `redactText(text, secrets)` is the redaction alone. Where transcripts are stored is the caller's choice (the server: the artifact store).

## Claude adapter

```ts
import { claudeAgent } from '@holtkeeper/agent'
import { env } from '@holtkeeper/forge'

const agent = claudeAgent({ apiKey: env('ANTHROPIC_API_KEY') })
const { output } = await agent.run({ dir, prompt: 'Find dead code', output: schema })
```

`claudeAgent({ apiKey, connection?, tierModels?, modelMap?, pricing?, timeoutMs?, maxTurns?, pathToClaudeCodeExecutable? })` (see [Providers](#providers) for `connection`):

- `apiKey` is a `Secret`, resolved on every `run` and passed only to the Claude Code process.
- The model (`modelFor(options, tier)`) is `tierModels[task.tier ?? 'main']`, else the tier's fallback, then `modelMap`; the SDK gets the tier's `effort`. `maxTurns` applies to tasks without their own.

What a task gets:

| Capability | Tools           |
| ---------- | --------------- |
| `read`     | `Read`, `Glob`  |
| `search`   | `Grep`          |
| `run`      | `Bash`          |
| `edit`     | `Edit`, `Write` |

- Only those tools exist in the session (`tools`), and every permission request goes through a gate that denies other tools and file paths outside `task.dir` (symlinks resolved).
- `cwd` is `task.dir`. No host settings, hooks, CLAUDE.md or host MCP servers are loaded (`strictMcpConfig`), sessions are not persisted.
- `task.toolsets` are served by one in-process SDK MCP server named `holtkeeper` (`toMcpServer`); their tools (`mcp__holtkeeper__code_search`, ...) are added to `allowedTools` and the gate, and the system prompt tells the model to prefer them over reading whole files. `task.mcpServers` are mounted as given and every `mcp__<server>__*` tool of them is allowed. Everything else stays denied. The name `holtkeeper` is reserved.
- The process environment is reduced to `PATH`, `HOME`, `USER`, `SHELL`, `TMPDIR`, `LANG`, `LC_ALL`, `TERM` plus the connection's variables, so host tokens do not reach shell commands, and `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` keeps the provider credentials out of them too.
- With `run`, Bash runs in the Claude Code sandbox with unsandboxed commands disabled.
- `task.signal` aborts the Claude Code process.
- With `output`, the system prompt asks for a single JSON answer. The result is taken from the SDK's `structured_output` when present, otherwise parsed from the final text (bare, fenced or surrounded by prose) and validated. Invalid answers throw `AgentOutputError`.
- System prompt order: `task.system`, `task.context`, confinement and tool rules, answer format. None of it depends on the run (the checkout path reaches the model through Claude Code's dynamic section, `excludeDynamicSections`), so runs with the same task kind, context and tools share a cached prefix.
- `turns`, `costUsd` and `usage` come from the SDK result message (`usage` summed over `modelUsage`, falling back to the main loop's `usage`). Error results (`error_max_turns`, `error_during_execution`, ...) throw with the SDK's errors.

## Providers

An AI provider is a credential (`@holtkeeper/credentials`) whose `kind` is one of `AI_PROVIDER_KINDS` (`anthropic`, `anthropic-compatible`, `ai-sdk`) and whose `options` hold the provider configuration. `createAgent({ kind, url, secret, options }, { runner?, tierModels?, maxTurns?, limiter?, pricing?, plugins?, agentLoop? })` validates them with `providerOptionsSchema` (a zod discriminated union on `kind`; throws listing every problem; unknown keys such as an old `model` are dropped) and returns a `ProviderAgent` (`Agent` plus `provider` kind, `modelFor(tier)`, the provider's model name of a tier after `modelMap`, and `runtimeFor(task)`, see [Runtime routing](#runtime-routing)). Without `tierModels` every tier runs on its fallback. The endpoint is `options.baseUrl`, else the credential `url`.

| `kind`                 | Runs on                                           | Secret                                                                                      | Options                                                                                          |
| ---------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `anthropic`            | Claude Agent SDK (tool loops), AI SDK (one-shots) | API key                                                                                     | `baseUrl?`                                                                                       |
| `anthropic-compatible` | Claude Agent SDK (tool loops), AI SDK (one-shots) | gateway key or token                                                                        | `baseUrl?`, `authHeader: 'x-api-key' \| 'bearer'` (default `x-api-key`), `headers?`              |
| `ai-sdk`               | Vercel AI SDK                                     | the provider's API key; for Vertex or Bedrock packages optionally their credentials as JSON | `provider`, `package` (default `@ai-sdk/openai-compatible`), `baseUrl?`, `headers?`, `settings?` |

Common options: `modelMap` (logical id → the provider's model name, e.g. `claude-opus-5-5` → `corp-opus`), `pricing` (`{ [model]: { inputPerMTok, outputPerMTok, cacheReadPerMTok?, cacheWritePerMTok? } }`, keyed by provider or logical name), `timeoutMs` (one model request) and `maxConcurrency` (runs at once; pass a shared `limiter` from `createLimiter` so every agent of one credential shares the slots). `{secret}` in a header value is replaced by the credential secret, so a gateway that wants the key in a custom header needs no secret in `options`.

Helpers: `listProviderModels`, `resolveLatestModel`, `resolveTierModels`, `modelCatalog`, `parseProviderOptions`, `providerOptionsIssues(kind, options)`, `aiProviderOptionsValidator` / `aiProviderOptionsValidatorFor(plugins)` (plug into `createCredentialService({ validateOptions })`), `isAiProviderKind`, `mapModel`, `renderHeaders`, `costFromPricing`, `createLimiter`, `limitConcurrency(agent, max | limiter)`.

### Models

`listProviderModels(provider, { fetch?, signal?, catalog? })` returns `{ models, error? }`: what the provider's API lists (Anthropic and Anthropic-compatible `GET /v1/models`, paged; `ai-sdk` providers from the catalog, else their OpenAI-compatible `GET /models`) plus every model the options name (`modelMap` targets, `pricing` keys, as `source: 'config'`). Each model has `id`, `name?`, `createdAt?` and `pricing?`: the `pricing` option (by provider or logical name) wins, else OpenRouter-style per-token prices in the listing (`pricing.prompt`, `pricing.completion`, `input_cache_read`, `input_cache_write`) converted to per-MTok. A failing API call becomes `error`; the configured models are still returned.

`resolveLatestModel('<prefix>@latest', models)` picks, among ids that are `<prefix>` followed only by numeric parts (`claude-opus@latest` → `claude-opus-5-5`, never `claude-opus-5-5-mini`), the highest version, then the latest 8-digit date suffix, then the latest `createdAt`. Dots and dashes between digits are one separator (`claude-sonnet-4-6@latest` matches `claude-sonnet-4.6`); vendor-prefixed ids of routers (`vendor/claude-opus-5-5`) match a reference without a vendor, and `vendor/claude-opus@latest` only that vendor's models; when the same version is listed with and without a vendor the id without one wins, and remaining ties go to the alphabetically first id. `modelCatalog({ ttlMs? })` caches listings per key for an hour and forgets failed ones. The server resolves the tiers with `resolveTierModels` before every agent it builds and serves listings at `GET /api/credentials/:id/models` (`credentials:read`).

### Connecting a corporate proxy

An Anthropic-compatible gateway (a proxy speaking the Messages API at `/v1/messages`: Waibee's Messages root, LiteLLM's Anthropic route, Portkey, ...) keeps the full Claude Code toolset as long as its probe passes:

```json
{
  "name": "Corp gateway",
  "kind": "anthropic-compatible",
  "url": "https://llm.corp.example/anthropic",
  "secret": "<gateway token>",
  "scope": { "all": true },
  "options": {
    "authHeader": "bearer",
    "headers": { "X-Team": "platform", "X-Portkey-Api-Key": "{secret}" },
    "modelMap": { "claude-opus-5-5": "corp-opus", "claude-haiku-5-5": "corp-haiku" },
    "pricing": { "corp-opus": { "inputPerMTok": 5, "outputPerMTok": 25 } },
    "timeoutMs": 600000,
    "maxConcurrency": 4
  }
}
```

The URL is the gateway root that Claude Code appends `/v1/messages` to. A gateway that lists its models under its own names resolves no tier; when its listing fails the tiers fall back to `claude-haiku-5-5`, `claude-sonnet-5-5` and `claude-opus-5-5`, which `modelMap` maps to the gateway's names. Any other API, OpenAI-compatible ones included, is an `ai-sdk` credential. Then set the global setting `llm.provider` to the credential's id or name.

### Claude Agent SDK connections

`ClaudeAgentOptions.connection` maps to the variables Claude Code reads (`claudeEnv`):

- `anthropic`: `ANTHROPIC_API_KEY`; `ANTHROPIC_BASE_URL` unless the URL is `api.anthropic.com`.
- `anthropic-compatible`: `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` (x-api-key) or `ANTHROPIC_AUTH_TOKEN` (bearer), `ANTHROPIC_CUSTOM_HEADERS` (one `Name: value` per line), `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.
- Every connection: `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, so Claude Code strips provider credentials from Bash and other subprocesses; `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, so runs never read or write Claude Code's memory; `API_TIMEOUT_MS` from `timeoutMs`; `ANTHROPIC_DEFAULT_HAIKU_MODEL` set to the `fast` tier's model after `modelMap` (Claude Code's background model).
- `modelMap` is applied to the tier's model; when `pricing` has the task's model (provider or logical name), `costUsd` is computed from usage instead of taken from the SDK, whose price table does not know proxy model names.

## AI SDK adapter

The `ai-sdk` kind reaches any provider of the [Vercel AI SDK](https://ai-sdk.dev/docs/foundations/providers-and-models): OpenAI, Anthropic, Google, Vertex, Bedrock, Azure, Mistral, Groq, xAI, DeepSeek, Cohere, Together, Fireworks, Cerebras, DeepInfra, Perplexity, the Vercel AI Gateway, OpenRouter and Ollama ship as packages (`AI_SDK_PACKAGES`); every other OpenAI-compatible API, from the catalog or of your own, goes through `@ai-sdk/openai-compatible` with its base URL.

```json
{
  "name": "OpenRouter",
  "kind": "ai-sdk",
  "url": "https://openrouter.ai/api/v1",
  "secret": "<OPENROUTER_API_KEY>",
  "scope": { "all": true },
  "options": {
    "provider": "openrouter",
    "package": "@openrouter/ai-sdk-provider"
  }
}
```

- `provider` is the catalog id (`openrouter`, `groq`, `moonshotai`, ...) or a name of your own; `package` picks the AI SDK provider. `settings` go to its `create...` function as they are (`{ region }` for Bedrock, `{ project, location }` for Vertex, `{ resourceName }` for Azure). The OpenAI-compatible package needs a base URL: `baseUrl`, else the credential `url`.
- `aiSdkLanguageModel(connection, modelId)` builds the model; `createAiSdkAgent({ languageModel, tierModels, modelMap?, pricing?, timeoutMs?, maxTurns?, runner?, limits? })` runs `tierModels[task.tier ?? 'main']` on `generateText` with `reasoning` set to the tier's effort, `stopWhen: stepCountIs(maxTurns)` (default `DEFAULT_AI_SDK_MAX_TURNS`, 40) and one tool call at a time.
- Repeated calls: a tool call identical to an earlier one (same tool, same arguments, key order ignored) since the last `edit_file`, `write_file` or `run_command` is not run again; the model gets `error: identical call #N — …` saying the result will not change. Those three tools always run and reset the memory, so re-reading a file or re-running tests after a change works. Three steps in a row of nothing but such repeats end the loop early.
- Turn limit: when the loop ends on tool calls (turn limit or repeats) below the cost cap, one more request with the same tools and `toolChoice: 'none'` (so the cached prefix holds) asks for the final answer, saying why the loop stopped (turn limit or repeated calls), and is parsed like any other. It counts as a turn, so `turns` can be `maxTurns + 1`. Only when that request fails or gives no text, or its structured answer does not parse, the run throws `MaxTurnsError` (message `error_max_turns`) carrying `usage`, `costUsd` and `turns`, which the transcript's `end` line and usage records keep.
- Transcript: each step is written when it finishes (`onStepEnd`), with the step's reasoning text, and calls the SDK refused (unknown tool, invalid input) appear as `tool-result` lines with `isError`. Through OpenRouter, Waibee and other routers the tiers resolve to their vendor-prefixed Claude models.
- Tools per capability (`localTools`): `read` → `read_file` (numbered lines, `offset`/`limit`), `glob`; `search` → `grep` (regex, optional glob, `path` a directory or a single file); `edit` → `edit_file` (exact, unique `old_string` unless `replace_all`), `write_file`; `run` → `run_command` (`sh -c` in `task.dir` through the injected `CommandRunner`, so the job's container runner applies; without a runner `run` grants nothing). Every path is resolved inside `task.dir` with symlinks resolved (`resolveInside`); anything outside answers the model with an error result. Every `task.toolsets` tool is offered under its MCP-style name (`code.search` → `code_search`); duplicates throw. Tool results are cut at `limits.maxOutputChars` (30 000).
- System prompt: `task.system`, `task.context`, confinement and tool list, then for `output` the answer format (the JSON is the text of the final message; there is no answer tool) with the JSON schema of the zod schema.
- Prompt caching: the system prompt carries an Anthropic cache breakpoint (`providerOptions.anthropic.cacheControl`), which also covers the tool definitions sent before it, and every step moves a second breakpoint to the newest message, so each turn of the tool loop reads the previous turn's prefix from the cache. Providers built on `@ai-sdk/anthropic` (Anthropic, Vertex Anthropic, Waibee Messages, ...) honor it; others ignore it.
- Shallow answers: with `task.followUpWithoutTools`, an answer given before any tool call gets that text as one more user message; its turns and usage add to the run's, and the second answer wins unless it is invalid or missing, in which case the first one is returned; it is also returned when the follow-up runs into the cost cap.
- Structured output is parsed from the answer text (`parseAgentOutput`) with one corrective turn, then `AgentOutputError`; no tool or `responseFormat` is forced, which models that reject forced `tool_choice` (Claude 5.5) need.
- `pingAiSdkProvider(provider, model, { plugins? })` asks the model for a one-word reply (the server's credential test of `ai-sdk` credentials).

### Provider plugins

A provider without a shipped package, typically a community AI SDK provider, is added as an `AiProviderPlugin`: its `package` is the value `ai-sdk` credentials name, `languageModel(connection, modelId)` builds the model from the credential (secret, `baseUrl`, rendered `headers`, `settings`), and the optional `catalog()` returns its catalog entries (`CatalogProvider`, prices per MTok), which `withPluginCatalogs(base, plugins, { ttlMs?, onError? })` adds to the models.dev catalog (a plugin entry replaces a models.dev one of the same id; a failing plugin catalog keeps its last good copy or is left out). Once added, the provider shows up in the credential form, its models list and resolve the model tiers, and catalog prices price its runs. A models.dev-shaped document, e.g. a package's own export, reads with `parseModelsDev({ [id]: entry })`.

[@holtkeeper/ai-waibee](../../ai-waibee/docs/README.md) is one, roughly:

```ts
import { defineAiProvider, parseModelsDev } from '@holtkeeper/agent'
import { WAIBEE_MODELS_SNAPSHOT, createWaibee, toModelsDev } from '@holtkeeper/waibee-ai-provider'

export const waibee = () =>
  defineAiProvider({
    package: '@holtkeeper/waibee-ai-provider',
    languageModel: (c, modelId) =>
      createWaibee({ apiKey: c.secret, ...(c.baseUrl && { baseURL: c.baseUrl }) })(modelId),
    catalog: () => parseModelsDev({ waibee: toModelsDev(WAIBEE_MODELS_SNAPSHOT.models) }),
  })
```

Plugins are listed in the config's `ai.providers` (`@holtkeeper/core`). `createAgent` and `pingAiSdkProvider` take them as `plugins` and refuse any other unknown package; `aiSdkLanguageModel(connection, modelId, plugins)` and `isSupportedProvider(provider, plugins)` consult them; `aiSdkPackages(plugins)` lists every package; `aiProviderOptionsValidatorFor(plugins)` is the credential validator that accepts their packages (`aiProviderOptionsValidator` accepts shipped packages only).

### Catalog

`modelsDevCatalog({ url?, ttlMs?, fetch? })` loads [models.dev](https://github.com/anomalyco/models.dev) (`MODELS_DEV_URL`) on first use, caches it for a day and keeps the last good copy when a refresh fails. `parseModelsDev(json)` reads its providers (`id`, `name`, `package`, `api?`, `doc?`, `env`) and models (`toolCall`, `reasoning`, `releaseDate`, `contextWindow`, `outputLimit`, `pricing` per MTok). `isSupportedProvider` says whether Holtkeeper can talk to one (its package ships or is a plugin's, or it has an OpenAI-compatible `api`). With `catalog` in `listProviderModels` deps, `ai-sdk` providers list the catalog's models; providers of your own list their `/models`.

## Other exports

- `createClaudeAgent(options, { query })` — the same adapter with an injectable `query`; tests feed scripted SDK messages.
- `transcribeSdkMessage(message, sink)` — the Claude adapter's mapping of one SDK message to transcript entries.
- `claudeOptionsFor(options, task, abortController)`, `claudeEnv(options)`, `toolsFor(capabilities)`, `CAPABILITY_TOOLS`, `systemPromptFor(...)`, `modelFor(options, tier)`, `usageOf(result)` — the mapping, exposed for tests and other adapters.
- `toMcpServer(toolsets, ctx, name?)`, `sdkTool(tool, ctx)`, `mcpToolName`, `qualifiedToolName`, `TOOLSET_SERVER` — toolsets as an SDK MCP server.
- `parseAgentOutput(text, schema)`, `validateAgentOutput(value, schema)`, `AgentOutputError` — answer parsing that any adapter can reuse.

## Limitations

- Running the Claude Agent SDK through Waibee Messages (tool use, streaming, `cache_control`) is not verified end to end yet; the probe covers tool use with one request. If it fails, tool loops fall back to the AI SDK loop automatically.
- The AI SDK adapter does not mount external MCP servers (`task.mcpServers`), has no sandbox of its own (command confinement is the runner's job: use the container runner for untrusted repositories) and does not stream.

- Path confinement covers the file tools. Shell commands are confined by the sandbox, which depends on the platform (Seatbelt on macOS, bubblewrap on Linux); where it is unavailable Claude Code decides how to proceed.
