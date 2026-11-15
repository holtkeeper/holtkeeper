# @holtkeeper/embed

The embeddings contract: an `Embedder` turns texts into vectors, plus the vector helpers every
user of vectors needs and a deterministic fake for tests. Dependency-free. Adapters live in their
own packages; the first is [@holtkeeper/embed-openai](../../embed-openai/docs/README.md) (the
OpenAI Embeddings format, which Waibee Router speaks too).

Vectors only rank and dedupe: knowledge applicability never depends on them (see
[Teams and paths › Knowledge](../../../docs/teams-and-paths.md#knowledge)).

## Contract

```ts
type EmbedPurpose = 'document' | 'query'
interface EmbedResult {
  vectors: Float32Array[]
  tokens: number
}
interface Embedder {
  readonly id: string // `<provider>:<model>@<dimensions>`
  readonly model: string
  readonly dimensions: number
  embed(texts: readonly string[], purpose: EmbedPurpose, signal?: AbortSignal): Promise<EmbedResult>
}
```

- `embed` returns one unit-length vector of `dimensions` numbers per text, in input order, and the
  tokens billed (0 when the provider reports none). It throws on transport and API errors.
- `id` is stored with every vector. Vectors only compare when their `id` is the same; a new `id`
  (another model, another dimension count) means re-embedding.
- `purpose` says whether a text is a stored document or a search query. Models trained with
  asymmetric prefixes embed them differently; the rest ignore it.

## Helpers

| Function                                 | Guarantee                                                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `cosine(a, b)`                           | Cosine similarity, -1…1; 0 when either vector is all zeros; `RangeError` on different lengths                             |
| `normalize(vector)`                      | A new unit-length `Float32Array`; an all-zero vector stays zeros                                                          |
| `encodeVector(vector)`                   | Bytes for storage: little-endian `float32`, four bytes per number, whatever the host byte order                           |
| `decodeVector(bytes)`                    | The vector back, also from a view into a larger buffer (a driver's `Buffer`); `RangeError` on a length not divisible by 4 |
| `contentHash(text)`                      | SHA-256 hex of the exact text: stored next to a vector to tell when the text changed                                      |
| `reciprocalRankFusion(rankings, k = 60)` | id → Σ 1/(k + rank) over rankings of ids (best first, rank from 1); a missing id gets nothing from that ranking           |

## Testing

`@holtkeeper/embed/testing` exports `createFakeEmbedder({ dimensions?, id? })`: an offline
embedder whose vector of a text is its hashed bag of lower-cased words and word bigrams,
normalized. It is deterministic (same text, same vector, whatever the purpose), texts that share
words get a high cosine and unrelated ones a cosine near 0. `dimensions` defaults to 256, the id
to `fake:hashed-words@<dimensions>`, `tokens` is the word count, and `calls` records every
`{ texts, purpose }`.
