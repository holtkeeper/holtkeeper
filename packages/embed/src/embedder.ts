/**
 * What a text is embedded as: a stored `document` or a search `query`. Models trained with
 * asymmetric prefixes embed the two differently; others ignore it.
 */
export type EmbedPurpose = 'document' | 'query'

/** The vectors of one `Embedder.embed` call. */
export interface EmbedResult {
  /** One unit-length vector of `Embedder.dimensions` numbers per input text, in input order. */
  vectors: Float32Array[]
  /** Tokens the provider billed for the call; 0 when it reports none. */
  tokens: number
}

/** Turns texts into vectors. Implementations: `@holtkeeper/embed-openai`, the fake in `./testing`. */
export interface Embedder {
  /** Stable id stored with every vector: `<provider>:<model>@<dimensions>`; a new id means re-embed. */
  readonly id: string
  /** The model id as the provider names it. */
  readonly model: string
  /** Length of every vector this embedder returns. */
  readonly dimensions: number
  /** One unit-length vector per text, same order. Throws on transport/API errors. */
  embed(texts: readonly string[], purpose: EmbedPurpose, signal?: AbortSignal): Promise<EmbedResult>
}
