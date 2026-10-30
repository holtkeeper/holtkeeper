import type { ModelPricing } from './provider.ts'

/** One model of a catalog provider. */
export interface CatalogModel {
  id: string
  name?: string
  /** Whether the model calls tools; agents need it. */
  toolCall: boolean
  reasoning: boolean
  /** ISO date the model was released, when known. */
  releaseDate?: string
  contextWindow?: number
  outputLimit?: number
  pricing?: ModelPricing
}

/** A provider of the catalog and the AI SDK package that talks to it. */
export interface CatalogProvider {
  id: string
  name: string
  /** npm package of the AI SDK provider, e.g. `@ai-sdk/openai-compatible`. */
  package: string
  /** API root, given for OpenAI-compatible providers. */
  api?: string
  doc?: string
  /** Environment variables the provider's key usually lives in. */
  env: string[]
  models: CatalogModel[]
}

/** A provider and model catalog, e.g. `modelsDevCatalog()`. */
export interface AiCatalog {
  providers(): Promise<CatalogProvider[]>
}

/** Where `modelsDevCatalog` loads the catalog from by default. */
export const MODELS_DEV_URL = 'https://models.dev/api.json'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined)

const amount = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined

function pricingOf(cost: unknown): ModelPricing | undefined {
  if (!isRecord(cost)) return undefined
  const input = amount(cost.input)
  const output = amount(cost.output)
  if (input === undefined || output === undefined) return undefined
  const cacheRead = amount(cost.cache_read)
  const cacheWrite = amount(cost.cache_write)
  return {
    inputPerMTok: input,
    outputPerMTok: output,
    ...(cacheRead !== undefined && { cacheReadPerMTok: cacheRead }),
    ...(cacheWrite !== undefined && { cacheWritePerMTok: cacheWrite }),
  }
}

function modelOf(id: string, value: unknown): CatalogModel | undefined {
  if (!isRecord(value)) return undefined
  const limit = isRecord(value.limit) ? value.limit : {}
  const name = text(value.name)
  const releaseDate = text(value.release_date)
  const contextWindow = amount(limit.context) || undefined
  const outputLimit = amount(limit.output) || undefined
  const pricing = pricingOf(value.cost)
  return {
    id: text(value.id) ?? id,
    ...(name && { name }),
    toolCall: value.tool_call === true,
    reasoning: value.reasoning === true,
    ...(releaseDate && { releaseDate }),
    ...(contextWindow !== undefined && { contextWindow }),
    ...(outputLimit !== undefined && { outputLimit }),
    ...(pricing && { pricing }),
  }
}

/** Providers of a models.dev `api.json` document; entries it cannot read are skipped. */
export function parseModelsDev(document: unknown): CatalogProvider[] {
  if (!isRecord(document)) return []
  return Object.entries(document).flatMap(([key, value]): CatalogProvider[] => {
    if (!isRecord(value)) return []
    const id = text(value.id) ?? key
    const name = text(value.name) ?? id
    const pkg = text(value.npm)
    if (!pkg) return []
    const api = text(value.api)
    const doc = text(value.doc)
    const models = isRecord(value.models)
      ? Object.entries(value.models).flatMap(([modelId, model]) => modelOf(modelId, model) ?? [])
      : []
    return [
      {
        id,
        name,
        package: pkg,
        ...(api && { api }),
        ...(doc && { doc }),
        env: Array.isArray(value.env)
          ? value.env.filter((e): e is string => typeof e === 'string')
          : [],
        models,
      },
    ]
  })
}

/**
 * The models.dev catalog (`url`, default `MODELS_DEV_URL`), fetched on first use and cached for
 * `ttlMs` (default a day). A failed refresh keeps serving the last good copy; with none it throws.
 */
export function modelsDevCatalog(
  options: { url?: string; ttlMs?: number; now?: () => number; fetch?: typeof fetch } = {},
): AiCatalog {
  const { url = MODELS_DEV_URL, ttlMs = 86_400_000, now = Date.now } = options
  const doFetch = options.fetch ?? fetch
  let cached: { at: number; providers: CatalogProvider[] } | undefined
  let loading: Promise<CatalogProvider[]> | undefined

  const load = async () => {
    const response = await doFetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`)
    const providers = parseModelsDev(await response.json())
    if (!providers.length) throw new Error(`GET ${url}: no providers`)
    cached = { at: now(), providers }
    return providers
  }

  return {
    async providers() {
      if (cached && now() - cached.at < ttlMs) return cached.providers
      loading ??= load().finally(() => (loading = undefined))
      try {
        return await loading
      } catch (error) {
        if (cached) return cached.providers
        throw error
      }
    },
  }
}
