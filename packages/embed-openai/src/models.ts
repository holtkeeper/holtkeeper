import { type HttpOptions, isRecord, requestJson } from './http.ts'

/** An embedding model a key can use. */
export interface EmbeddingModel {
  /** The id to pass as `model`, e.g. `openai/text-embedding-3-small`. */
  id: string
  /** Default vector length, when the catalog or the known models table says. */
  dimensions?: number
  /** Dollars per million input tokens, when the catalog has prices. */
  pricePerMillionTokens?: number
}

const KNOWN: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
}

/** Default vector length of a well-known model, with or without a vendor prefix. */
export function knownDimensions(model: string): number | undefined {
  return KNOWN[model.slice(model.lastIndexOf('/') + 1)]
}

const amount = (value: unknown): number | undefined => {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined
}

/**
 * The embedding models of `GET {url}/models?output_modalities=embeddings`, sorted by id. Gateways
 * that tag models with `model_class` (Waibee Router) keep only `embedding` ones; others (plain
 * OpenAI ignores the filter) keep the ids containing `embed`. `dimensions` comes from the catalog
 * entry when it has one, else from the known models table; `pricePerMillionTokens` from
 * `pricing.prompt` (dollars per token, Waibee's catalog field) times a million, else absent.
 * Throws `EmbeddingError` like the embedder.
 */
export async function listEmbeddingModels(
  options: Pick<HttpOptions, 'url' | 'apiKey' | 'fetch'>,
): Promise<EmbeddingModel[]> {
  const body = await requestJson(options, '/models?output_modalities=embeddings', {
    method: 'GET',
  })
  const entries: unknown[] = isRecord(body) && Array.isArray(body.data) ? body.data : []
  return entries
    .filter(
      (entry): entry is Record<string, unknown> & { id: string } =>
        isRecord(entry) && typeof entry.id === 'string',
    )
    .filter((entry) =>
      typeof entry.model_class === 'string'
        ? entry.model_class === 'embedding'
        : entry.id.includes('embed'),
    )
    .map((entry) => {
      const dimensions = amount(entry.dimensions) || knownDimensions(entry.id)
      const price = amount(isRecord(entry.pricing) ? entry.pricing.prompt : undefined)
      const model: EmbeddingModel = { id: entry.id }
      if (dimensions) model.dimensions = dimensions
      // toPrecision drops the float noise of the per-token price (0.00000002 → 0.02, not 0.019999…).
      if (price !== undefined) model.pricePerMillionTokens = Number((price * 1e6).toPrecision(12))
      return model
    })
    .toSorted((a, b) => a.id.localeCompare(b.id))
}
