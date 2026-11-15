# @holtkeeper/embed-openai

An [`Embedder`](../../embed/docs/README.md) over the OpenAI Embeddings format
(`POST {url}/embeddings`), which OpenAI, [Waibee Router](https://docs.waibee.com/router/embeddings/)
and most gateways speak. The AI credential already in the panel (kind `ai-sdk`: a `url` and a
secret) is enough to use it.

## Embedder

```ts
import { createOpenAiEmbedder } from '@holtkeeper/embed-openai'

const embedder = createOpenAiEmbedder({
  url: 'https://api.waibee.com/v1', // base URL, without /embeddings
  apiKey: secret,
  model: 'openai/text-embedding-3-small',
})
const { vectors, tokens } = await embedder.embed(['Round the widget corners'], 'document')
```

`OpenAiEmbedderOptions`:

| Option                            | Meaning                                                                                                           |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `url`, `apiKey`, `model`          | Endpoint base URL, bearer key, model id as the endpoint names it (vendor prefix on Waibee)                        |
| `dimensions?`                     | Sent as `dimensions` only when set (not every model supports it)                                                  |
| `provider?`                       | Id prefix, default `openai`                                                                                       |
| `batchSize?`                      | Inputs per request, default 128, at most 2048 (Waibee's limit)                                                    |
| `queryPrefix?`, `documentPrefix?` | Prepended to texts by purpose, for models trained with asymmetric prefixes; the format itself ignores the purpose |
| `fetch?`                          | For tests                                                                                                         |

Guarantees:

- Requests carry `{ model, input: string[], encoding_format: 'float', dimensions? }`, one batch
  after another. Vectors come back normalized and in input order whatever order `data` has
  (`index` decides); base64 vectors are decoded too. `tokens` sums `usage.total_tokens` (or
  `prompt_tokens`) over the batches, 0 when the endpoint reports none. Empty texts go as a single
  space, since the endpoints reject empty strings.
- `dimensions` is `options.dimensions`, else the length of the first response's vectors, else the
  known size of the model (`text-embedding-3-small` 1536, `text-embedding-3-large` 3072,
  `text-embedding-ada-002` 1536, with or without a vendor prefix). Reading `dimensions` or `id`
  for an unknown model before the first call throws an error asking for `dimensions`.
  `id` is `<provider>:<model>@<dimensions>`.
- A vector of another length than expected throws `EmbeddingError` with code
  `dimension_mismatch`; an answer missing vectors throws code `invalid_response`.

## Models

`listEmbeddingModels({ url, apiKey, fetch? })` reads `GET {url}/models?output_modalities=embeddings`
and returns `EmbeddingModel { id, dimensions?, pricePerMillionTokens? }[]` sorted by id:

- with `model_class` on the entries (Waibee), only `embedding` models; without it (plain OpenAI
  ignores the filter), the ids containing `embed`;
- `dimensions` from a `dimensions` field when the catalog has one, else the known models table;
- `pricePerMillionTokens` from `pricing.prompt` (Waibee's catalog gives dollars per token), absent
  when there is no price.

## Errors and retries

A non-2xx answer throws `EmbeddingError { status, code?, message }`: `message` is the API's own
message (`error.message`, a short `{ "error": "..." }`, or the start of a non-JSON body) with the
key masked should the API echo it; the key never appears in errors. 429 and 5xx answers are
retried twice, waiting what `Retry-After` asks (seconds or a date, at most 60 s), else 1 s and
then 2 s. An aborted `signal` stops the request and any wait.
