# @holtkeeper/ai-waibee

[Waibee Router](https://docs.waibee.com/router/) as an AI provider plugin (`AiProviderPlugin` of
[@holtkeeper/agent](../../agent/docs/README.md#provider-plugins)), built on
[`@holtkeeper/waibee-ai-provider`](https://www.npmjs.com/package/@holtkeeper/waibee-ai-provider).
One Waibee key reaches the models of every vendor in its catalog.

## Setup

Add the plugin to the config:

```ts
import { waibee } from '@holtkeeper/ai-waibee'
import { defineConfig } from '@holtkeeper/core'

export default defineConfig({
  // ...
  ai: { providers: [waibee()] },
})
```

Waibee then shows up in the AI provider list of the credential form, with its models and prices.
A credential stores the key as its secret:

```json
{
  "name": "Waibee",
  "kind": "ai-sdk",
  "url": "https://api.waibee.com/v1",
  "secret": "<WAIBEE_API_KEY>",
  "scope": { "all": true },
  "options": {
    "provider": "waibee",
    "package": "@holtkeeper/waibee-ai-provider"
  }
}
```

Model ids carry the vendor prefix (`anthropic/claude-sonnet-4.6`, `openai/gpt-5.4`); agents run
on the model tiers of `@holtkeeper/agent`, which resolve to the newest `anthropic/claude-*` models
the catalog lists.

## API

`waibee({ apiKey?, baseUrl?, id?, listModels? })` returns the plugin. `WAIBEE_PACKAGE` is the
`package` value credentials use.

- Claude models (`anthropic/claude-*`, `claude-*`) run on Anthropic Messages, where the agent's
  prompt-cache breakpoints apply, so repeated turns are billed as cache reads; every other model
  runs on Chat Completions. `options.settings: { endpoint: 'chat' | 'messages' }` on a credential
  forces one route for all its models.
- A spent key limit or balance (`api_key_limit_exceeded`, `insufficient_funds`, HTTP 402) fails
  the run with `BudgetExceededError` from `@holtkeeper/agent`.
- `baseUrl` and `headers` of a credential apply to its runs; the router's default base URL is used
  otherwise.
- The catalog (provider id `waibee`, or `id`) lists Waibee's chat models with prices per million
  tokens, so runs are priced and model tiers resolve. It is listed with `apiKey`, default
  `WAIBEE_API_KEY` from the server environment, so prices follow that account's plan; without a key
  it is the snapshot bundled with the provider package, with approximate prices. It is refreshed
  daily.
