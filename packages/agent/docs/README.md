# @holtkeeper/agent

The `Agent` contract for LLM work on a repository checkout (code review, refactoring, writing tests), its Claude implementation on the [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview), an OpenAI-compatible implementation with its own tool loop, and `createAgent`, which builds either from an AI provider credential. Callers depend on `Agent` only; the provider is configuration.

## Contract

- `Agent { name; run(task) }` — runs one task in `task.dir` and resolves with `AgentResult { text, output?, turns, costUsd?, usage? }`; `usage` is `{ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }`.
- `AgentTask` — `dir`, `prompt`, optional `system`, `capabilities` (default `['read', 'search']`), `output` (a zod schema the answer must match), `maxTurns`, `signal`, and:
  - `taskKind` — `review`, `refactor`, `triage`, ...; adapters route the model by it.
  - `context` — a pre-selected knowledge/conventions block, placed early in the system prompt.
  - `toolsets` — in-process tools (`Toolset { name; tools: AgentTool[] }`), e.g. from `@holtkeeper/agent-tools`.
  - `mcpServers` — external MCP servers by name (SDK `McpServerConfig`), e.g. Context7.
- `AgentCapability` — `read`, `search`, `run`, `edit`.
- `AgentTool { name; description; input: z.ZodObject; run(input, { dir, signal }) → string }` — returns compact text within its own output budget; a thrown error is reported to the model, not to the caller.

## Claude adapter

```ts
import { claudeAgent } from '@holtkeeper/agent'
import { env } from '@holtkeeper/forge'

const agent = claudeAgent({ apiKey: env('ANTHROPIC_API_KEY') })
const { output } = await agent.run({ dir, prompt: 'Find dead code', output: schema })
```

`claudeAgent({ apiKey?, connection?, model?, models?, modelMap?, pricing?, timeoutMs?, maxTurns?, pathToClaudeCodeExecutable? })` (see [Providers](#providers) for `connection`):

- `apiKey` is a `Secret`, resolved on every `run` and passed only to the Claude Code process.
- Model routing (`modelFor`): `models[task.taskKind]`, else `model`, else `DEFAULT_CLAUDE_MODEL` (`claude-opus-5-5`); `taskKind: 'triage'` without a `models.triage` entry uses `DEFAULT_TRIAGE_MODEL` (`claude-haiku-5-5`). `maxTurns` applies to tasks without their own.

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

An AI provider is a credential (`@holtkeeper/credentials`) whose `kind` is one of `AI_PROVIDER_KINDS` and whose `options` hold the provider configuration. `createAgent({ kind, url, secret, options }, { runner?, model?, models?, maxTurns?, limiter? })` validates them with `providerOptionsSchema` (a zod discriminated union on `kind`; throws listing every problem) and returns a `ProviderAgent` (`Agent` plus `provider` kind and `modelFor(taskKind)`, the provider's model name after routing and `modelMap`). The endpoint is `options.baseUrl`, else the credential `url`.

| `kind`                 | Runs on          | Secret                                                                                                  | Options                                                                                          |
| ---------------------- | ---------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `anthropic`            | Claude Agent SDK | API key                                                                                                 | `baseUrl?`                                                                                       |
| `anthropic-compatible` | Claude Agent SDK | gateway key or token                                                                                    | `baseUrl?`, `authHeader: 'x-api-key' \| 'bearer'` (default `x-api-key`), `headers?`              |
| `bedrock`              | Claude Agent SDK | with `credentials: 'secret'`: Bedrock API key or `{ accessKeyId, secretAccessKey, sessionToken? }` JSON | `region`, `baseUrl?`, `credentials: 'env' \| 'secret'` (default `env`)                           |
| `vertex`               | Claude Agent SDK | with `credentials: 'secret'`: service account key JSON                                                  | `region`, `projectId`, `baseUrl?`, `credentials` (default `env`)                                 |
| `openai-compatible`    | own tool loop    | API key (`Authorization: Bearer`)                                                                       | `baseUrl?`, `headers?`, `supportsTools` (must be `true`), `jsonMode?`                            |
| `ai-sdk`               | Vercel AI SDK    | the provider's API key; for Vertex or Bedrock optionally their credentials as JSON                      | `provider`, `package` (default `@ai-sdk/openai-compatible`), `baseUrl?`, `headers?`, `settings?` |

Common options: `model` and `models` (per task kind) as defaults that `createAgent`'s `model`/`models` override, `modelMap` (logical id → the provider's model name, e.g. `claude-opus-5-5` → `corp-opus`), `pricing` (`{ [model]: { inputPerMTok, outputPerMTok, cacheReadPerMTok?, cacheWritePerMTok? } }`, keyed by provider or logical name), `timeoutMs` (one model request) and `maxConcurrency` (runs at once; pass a shared `limiter` from `createLimiter` so every agent of one credential shares the slots). `{secret}` in a header value is replaced by the credential secret, so a gateway that wants the key in a custom header needs no secret in `options`. With `env` credentials the secret is unused; store any placeholder.

Helpers: `listProviderModels`, `resolveLatestModel`, `resolveProviderRouting`, `modelCatalog`, `parseProviderOptions`, `providerOptionsIssues(kind, options)`, `aiProviderOptionsValidator` (plug into `createCredentialService({ validateOptions })`), `isAiProviderKind`, `mapModel`, `renderHeaders`, `costFromPricing`, `createLimiter`, `limitConcurrency(agent, max | limiter)`.

### Models

`listProviderModels(provider, { fetch?, signal? })` returns `{ models, error? }`: what the provider's API lists (Anthropic and Anthropic-compatible `GET /v1/models`, paged; OpenAI-compatible `GET /models`; Bedrock and Vertex have no listing) plus every model the options name (`model`, `models`, `modelMap` targets, `pricing` keys, as `source: 'config'`). Each model has `id`, `name?`, `createdAt?` and `pricing?`: the `pricing` option (by provider or logical name) wins, else OpenRouter-style per-token prices in the listing (`pricing.prompt`, `pricing.completion`, `input_cache_read`, `input_cache_write`) converted to per-MTok. A failing API call becomes `error`; the configured models are still returned.

`<prefix>@latest` in `model`, `models` (options, `createAgent` options or the `llm.model`/`llm.models` settings) means the newest listed version: `resolveLatestModel` picks, among ids that are `<prefix>` followed only by numeric parts (`claude-opus@latest` → `claude-opus-5-5`, never `claude-opus-5-5-mini`; `gpt@latest` → `gpt-5.1`), the highest version, then the latest 8-digit date suffix, then the latest `createdAt`. `resolveProviderRouting(provider, routing, list)` resolves the effective routing (asking `list` only when a reference ends in `@latest`) and throws naming references nothing matches; `modelCatalog({ ttlMs? })` caches listings per key for an hour and forgets failed ones. The server resolves `@latest` before every agent it builds and serves listings at `GET /api/credentials/:id/models` (`credentials:read`).

### Connecting a corporate proxy

An Anthropic-compatible gateway (a proxy speaking the Messages API at `/v1/messages`, LiteLLM's Anthropic route, Portkey, ...) keeps the full Claude Code toolset:

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

The URL is the gateway root that Claude Code appends `/v1/messages` to. Any Chat Completions API with tool calling (an OpenAI or Azure OpenAI proxy, LiteLLM `/v1/chat/completions`, vLLM, a gateway to GPT, Gemini or Llama models) works through the built-in tool loop:

```json
{
  "name": "Corp OpenAI proxy",
  "kind": "openai-compatible",
  "url": "https://llm.corp.example/v1",
  "secret": "<proxy key>",
  "scope": { "groups": ["platform"] },
  "options": {
    "model": "gpt-5",
    "models": { "triage": "gpt-5-mini" },
    "headers": { "X-Cost-Center": "4711" },
    "jsonMode": true,
    "pricing": { "gpt-5": { "inputPerMTok": 1.25, "outputPerMTok": 10, "cacheReadPerMTok": 0.125 } }
  }
}
```

Requests go to `<url>/chat/completions`. A header named `Authorization` in `headers` replaces the default `Bearer <secret>`. Then set the scoped setting `llm.provider` to the credential's id or name.

### Claude Agent SDK connections

`ClaudeAgentOptions.connection` maps to the variables Claude Code reads (`claudeEnv`):

- `anthropic`: `ANTHROPIC_API_KEY`; `ANTHROPIC_BASE_URL` unless the URL is `api.anthropic.com`.
- `anthropic-compatible`: `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` (x-api-key) or `ANTHROPIC_AUTH_TOKEN` (bearer), `ANTHROPIC_CUSTOM_HEADERS` (one `Name: value` per line).
- `bedrock`: `CLAUDE_CODE_USE_BEDROCK=1`, `AWS_REGION`, `ANTHROPIC_BEDROCK_BASE_URL`; `env` credentials pass the host's `AWS_*` credential variables through, `secret` sets `AWS_BEARER_TOKEN_BEDROCK` or the key pair.
- `vertex`: `CLAUDE_CODE_USE_VERTEX=1`, `CLOUD_ML_REGION`, `ANTHROPIC_VERTEX_PROJECT_ID`, `ANTHROPIC_VERTEX_BASE_URL`; `env` passes `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT`, `CLOUDSDK_CONFIG` through, `secret` writes the key to a `0600` file in a private temp directory for the run and removes it afterwards.
- Every connection: `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, so Claude Code strips provider credentials from Bash and other subprocesses; `API_TIMEOUT_MS` from `timeoutMs`; `ANTHROPIC_DEFAULT_HAIKU_MODEL` when `modelMap` maps `claude-haiku-5-5` (Claude Code's background model). Non-Anthropic connections also set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.
- `modelMap` is applied to the routed model; when `pricing` has the task's model (provider or logical name), `costUsd` is computed from usage instead of taken from the SDK, whose price table does not know proxy model names.

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
    "package": "@openrouter/ai-sdk-provider",
    "model": "openai/gpt-5"
  }
}
```

- `provider` is the catalog id (`openrouter`, `groq`, `moonshotai`, ...) or a name of your own; `package` picks the AI SDK provider. `settings` go to its `create...` function as they are (`{ region }` for Bedrock, `{ project, location }` for Vertex, `{ resourceName }` for Azure). The OpenAI-compatible package needs a base URL: `baseUrl`, else the credential `url`.
- `aiSdkLanguageModel(connection, modelId)` builds the model; `createAiSdkAgent({ languageModel, model?, models?, modelMap?, pricing?, timeoutMs?, maxTurns?, runner?, limits? })` runs it with the same tools, prompt and output handling as the OpenAI-compatible adapter below, on `generateText` with `stopWhen: stepCountIs(maxTurns)` and one tool call at a time. There is no default model: `models[taskKind]`, else `model`, else the run throws.
- `pingAiSdkProvider(provider, model)` asks the model for a one-word reply (the server's credential test).

### Catalog

`modelsDevCatalog({ url?, ttlMs?, fetch? })` loads [models.dev](https://github.com/anomalyco/models.dev) (`MODELS_DEV_URL`) on first use, caches it for a day and keeps the last good copy when a refresh fails. `parseModelsDev(json)` reads its providers (`id`, `name`, `package`, `api?`, `doc?`, `env`) and models (`toolCall`, `reasoning`, `releaseDate`, `contextWindow`, `outputLimit`, `pricing` per MTok). `isSupportedProvider` says whether Holtkeeper can talk to one (its package ships, or it has an OpenAI-compatible `api`). With `catalog` in `listProviderModels` deps, `ai-sdk` providers list the catalog's models; providers of your own list their `/models`.

## OpenAI-compatible adapter

`openAICompatibleAgent({ baseUrl, apiKey?, headers?, model?, models?, modelMap?, pricing?, timeoutMs?, maxTurns?, jsonMode?, runner?, limits? })` (`createOpenAICompatibleAgent(options, { fetch })` for tests) runs a bounded tool loop over Chat Completions with `tools`:

- Tools per capability (`localTools`): `read` → `read_file` (numbered lines, `offset`/`limit`), `glob`; `search` → `grep` (regex, optional glob); `edit` → `edit_file` (exact, unique `old_string` unless `replace_all`), `write_file`; `run` → `run_command` (`sh -c` in `task.dir` through the injected `CommandRunner`, so the job's container runner applies; without a runner `run` grants nothing). Every path is resolved inside `task.dir` with symlinks resolved (`resolveInside`); anything outside, and any tool not granted, answers the model with an error result.
- Every `task.toolsets` tool is offered under its MCP-style name (`code.search` → `code_search`); duplicates throw. `task.mcpServers` are not mounted by this adapter.
- System prompt: `task.system`, `task.context`, confinement and tool list, then for `output` the answer format with the JSON schema of the zod schema; `jsonMode` adds `response_format: { type: 'json_object' }`. The answer is parsed with `parseAgentOutput`; an invalid answer gets one corrective turn, then `AgentOutputError`.
- Limits: `task.maxTurns ?? maxTurns ?? DEFAULT_OPENAI_MAX_TURNS` (40) requests, then `error_max_turns`; tool results are cut at `limits.maxOutputChars` (30 000). `task.signal` aborts the request in flight and the loop; `timeoutMs` (default 300 s) bounds each request. HTTP errors throw with the status and the start of the body.
- `turns` is the number of requests; `usage` sums `prompt_tokens` (minus `prompt_tokens_details.cached_tokens`, which count as cache reads) and `completion_tokens`; `costUsd` is a reported `usage.cost` (LiteLLM, OpenRouter) when present, else computed with `pricing`.

## Other exports

- `createClaudeAgent(options, { query })` — the same adapter with an injectable `query`; tests feed scripted SDK messages.
- `claudeOptionsFor(options, task, abortController, files?)`, `claudeEnv(options, files?)`, `toolsFor(capabilities)`, `CAPABILITY_TOOLS`, `systemPromptFor(...)`, `modelFor(options, taskKind)`, `usageOf(result)` — the mapping, exposed for tests and other adapters.
- `toMcpServer(toolsets, ctx, name?)`, `sdkTool(tool, ctx)`, `mcpToolName`, `qualifiedToolName`, `TOOLSET_SERVER` — toolsets as an SDK MCP server.
- `parseAgentOutput(text, schema)`, `validateAgentOutput(value, schema)`, `AgentOutputError` — answer parsing that any adapter can reuse.

## Limitations

- The OpenAI-compatible and AI SDK adapters do not mount external MCP servers (`task.mcpServers`), has no sandbox of its own (command confinement is the runner's job: use the container runner for untrusted repositories) and does not stream.
- A Vertex key file written for a run lives outside `task.dir`, which the file tools cannot reach; a sandboxed Bash command could read it while the run lasts.

- Path confinement covers the file tools. Shell commands are confined by the sandbox, which depends on the platform (Seatbelt on macOS, bubblewrap on Linux); where it is unavailable Claude Code decides how to proceed.
