import {
  type AiProvider,
  type ModelPricing,
  type ProviderOptions,
  parseProviderOptions,
  renderHeaders,
} from './provider.ts'

/** One model a provider offers. */
export interface ProviderModel {
  /** The provider's model name, as sent in requests. */
  id: string
  /** Human-readable name, when the provider reports one. */
  name?: string
  /** When the provider published the model (ISO 8601), when it reports it. */
  createdAt?: string
  /** Prices from the provider's `pricing` option, else from the provider's own listing. */
  pricing?: ModelPricing
  /** `provider`: listed by the provider's API; `config`: only named in the provider's options. */
  source: 'provider' | 'config'
}

/** The models of a provider; `error` says why the provider's API could not be asked. */
export interface ModelListing {
  models: ProviderModel[]
  error?: string
}

export interface ListModelsDependencies {
  fetch?: typeof fetch
  signal?: AbortSignal
}

/** Suffix of a model reference that resolves to the newest listed version, e.g. `claude-opus@latest`. */
export const LATEST_SUFFIX = '@latest'

const ANTHROPIC_URL = 'https://api.anthropic.com'
const ANTHROPIC_VERSION = '2023-06-01'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const trimSlash = (url: string) => url.replace(/\/+$/, '')

const perMTok = (value: unknown): number | undefined => {
  const number = typeof value === 'string' ? Number(value) : value
  return typeof number === 'number' && Number.isFinite(number) && number >= 0
    ? number * 1_000_000
    : undefined
}

/** OpenRouter-style per-token prices (`pricing.prompt`, `pricing.completion`, ...), as per-MTok. */
function listedPricing(value: unknown): ModelPricing | undefined {
  if (!isRecord(value)) return undefined
  const input = perMTok(value.prompt)
  const output = perMTok(value.completion)
  if (input === undefined || output === undefined) return undefined
  const cacheRead = perMTok(value.input_cache_read)
  const cacheWrite = perMTok(value.input_cache_write)
  return {
    inputPerMTok: input,
    outputPerMTok: output,
    ...(cacheRead !== undefined && { cacheReadPerMTok: cacheRead }),
    ...(cacheWrite !== undefined && { cacheWritePerMTok: cacheWrite }),
  }
}

const dateOf = (value: unknown): string | undefined => {
  if (typeof value === 'number' && Number.isFinite(value))
    return new Date(value * 1000).toISOString()
  if (typeof value !== 'string') return undefined
  const time = Date.parse(value)
  return Number.isNaN(time) ? undefined : new Date(time).toISOString()
}

async function getJson(
  url: string,
  headers: Record<string, string>,
  deps: ListModelsDependencies,
): Promise<Record<string, unknown>> {
  const response = await (deps.fetch ?? fetch)(url, {
    headers: { accept: 'application/json', ...headers },
    ...(deps.signal && { signal: deps.signal }),
  })
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`)
  const body: unknown = await response.json()
  if (!isRecord(body)) throw new Error(`GET ${url}: not a JSON object`)
  return body
}

async function anthropicModels(
  baseUrl: string,
  headers: Record<string, string>,
  deps: ListModelsDependencies,
): Promise<ProviderModel[]> {
  const models: ProviderModel[] = []
  let after: string | undefined
  for (let page = 0; page < 20; page++) {
    const query = new URLSearchParams({ limit: '1000', ...(after && { after_id: after }) })
    // oxlint-disable-next-line no-await-in-loop
    const body = await getJson(`${trimSlash(baseUrl)}/v1/models?${query.toString()}`, headers, deps)
    const data = Array.isArray(body.data) ? body.data.filter(isRecord) : []
    for (const item of data) {
      if (typeof item.id !== 'string') continue
      const createdAt = dateOf(item.created_at)
      models.push({
        id: item.id,
        ...(typeof item.display_name === 'string' && { name: item.display_name }),
        ...(createdAt && { createdAt }),
        source: 'provider',
      })
    }
    after = typeof body.last_id === 'string' ? body.last_id : undefined
    if (body.has_more !== true || !after) break
  }
  return models
}

async function openAIModels(
  baseUrl: string,
  headers: Record<string, string>,
  deps: ListModelsDependencies,
): Promise<ProviderModel[]> {
  const body = await getJson(`${trimSlash(baseUrl)}/models`, headers, deps)
  const data = Array.isArray(body.data) ? body.data.filter(isRecord) : []
  return data.flatMap((item): ProviderModel[] => {
    if (typeof item.id !== 'string') return []
    const createdAt = dateOf(item.created)
    const pricing = listedPricing(item.pricing)
    return [
      {
        id: item.id,
        ...(typeof item.name === 'string' && { name: item.name }),
        ...(createdAt && { createdAt }),
        ...(pricing && { pricing }),
        source: 'provider',
      },
    ]
  })
}

function remoteModels(
  provider: AiProvider,
  options: ProviderOptions,
  deps: ListModelsDependencies,
): Promise<ProviderModel[]> | undefined {
  const baseUrl = ('baseUrl' in options ? options.baseUrl : undefined) ?? provider.url
  switch (options.kind) {
    case 'anthropic':
      return anthropicModels(
        baseUrl || ANTHROPIC_URL,
        {
          'x-api-key': provider.secret,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        deps,
      )
    case 'anthropic-compatible':
      return anthropicModels(
        baseUrl,
        {
          'anthropic-version': ANTHROPIC_VERSION,
          ...(options.authHeader === 'bearer'
            ? { authorization: `Bearer ${provider.secret}` }
            : { 'x-api-key': provider.secret }),
          ...renderHeaders(options.headers, provider.secret),
        },
        deps,
      )
    case 'openai-compatible': {
      const headers = renderHeaders(options.headers, provider.secret)
      const auth = Object.keys(headers).some((name) => name.toLowerCase() === 'authorization')
      return openAIModels(
        baseUrl,
        { ...(!auth && { authorization: `Bearer ${provider.secret}` }), ...headers },
        deps,
      )
    }
    default:
      return undefined
  }
}

/** Model names the provider's options mention: `model`, `models`, `modelMap` targets and `pricing`. */
function configuredModels(options: ProviderOptions): string[] {
  const named = [
    options.model,
    ...Object.values(options.models ?? {}),
    ...Object.values(options.modelMap ?? {}),
    ...Object.keys(options.pricing ?? {}),
  ]
  return [
    ...new Set(
      named
        .filter((name): name is string => name !== undefined)
        .map((name) => options.modelMap?.[name] ?? name)
        .filter((name) => !name.endsWith(LATEST_SUFFIX)),
    ),
  ]
}

/**
 * The models of an AI provider: what its API lists (Anthropic and Anthropic-compatible
 * `/v1/models`, OpenAI-compatible `/models`; Bedrock and Vertex have none), plus every model its
 * options name. Prices come from the `pricing` option (by provider or logical name), else from the
 * listing when it carries OpenRouter-style per-token prices. A failing API call is reported in
 * `error` with the configured models still returned.
 */
export async function listProviderModels(
  provider: AiProvider,
  deps: ListModelsDependencies = {},
): Promise<ModelListing> {
  const options = parseProviderOptions(provider)
  let listed: ProviderModel[] = []
  let error: string | undefined
  const remote = remoteModels(provider, options, deps)
  if (remote) {
    try {
      listed = await remote
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    }
  }

  const known = new Set(listed.map((model) => model.id))
  const all = [
    ...listed,
    ...configuredModels(options)
      .filter((id) => !known.has(id))
      .map((id): ProviderModel => ({ id, source: 'config' })),
  ]
  const logical = new Map(
    Object.entries(options.modelMap ?? {}).map(([name, target]) => [target, name]),
  )
  const models = all.map((model) => {
    const alias = logical.get(model.id)
    const configured =
      options.pricing?.[model.id] ?? (alias !== undefined ? options.pricing?.[alias] : undefined)
    return configured ? { ...model, pricing: configured } : model
  })
  return { models, ...(error !== undefined && { error }) }
}

const versionOf = (rest: string): { version: number[]; date: number } | undefined => {
  if (rest === '') return { version: [], date: 0 }
  if (!/^([-.]\d+)+$/.test(rest)) return undefined
  const parts = rest.slice(1).split(/[-.]/).map(Number)
  const last = parts.at(-1) ?? 0
  return parts.length > 0 && String(last).length >= 8
    ? { version: parts.slice(0, -1), date: last }
    : { version: parts, date: 0 }
}

const compareVersions = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? -1) - (b[i] ?? -1)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * The newest listed model for `reference`: `<prefix>@latest` picks, among models named `<prefix>`
 * followed only by numeric version parts (`claude-opus@latest` → `claude-opus-5-5`, not
 * `claude-opus-5-5-mini`), the highest version, then the latest date suffix (`-20261001`), then
 * the latest `createdAt`. Any other reference is returned as is; `undefined` when nothing matches.
 */
export function resolveLatestModel(
  reference: string,
  models: readonly Pick<ProviderModel, 'id' | 'createdAt'>[],
): string | undefined {
  if (!reference.endsWith(LATEST_SUFFIX)) return reference
  const prefix = reference.slice(0, -LATEST_SUFFIX.length)
  const candidates = models.flatMap((model) => {
    if (!model.id.startsWith(prefix)) return []
    const parsed = versionOf(model.id.slice(prefix.length))
    return parsed ? [{ ...parsed, id: model.id, createdAt: model.createdAt ?? '' }] : []
  })
  const [newest] = candidates.toSorted(
    (a, b) =>
      compareVersions(b.version, a.version) ||
      b.date - a.date ||
      b.createdAt.localeCompare(a.createdAt),
  )
  return newest?.id
}

/** Whether `reference` asks for the newest version (`...@latest`). */
export const isLatestReference = (reference: string | undefined): reference is string =>
  reference?.endsWith(LATEST_SUFFIX) === true

/**
 * `model` and `models` with every `@latest` reference resolved against `models` listed for the
 * provider. Throws naming the references nothing matches.
 */
export function resolveLatestRouting(
  routing: { model?: string; models?: Record<string, string> },
  listed: readonly Pick<ProviderModel, 'id' | 'createdAt'>[],
): { model?: string; models?: Record<string, string> } {
  const missing: string[] = []
  const resolve = (reference: string) => {
    const resolved = resolveLatestModel(reference, listed)
    if (resolved === undefined) missing.push(reference)
    return resolved ?? reference
  }
  const result = {
    ...(routing.model !== undefined && { model: resolve(routing.model) }),
    ...(routing.models && {
      models: Object.fromEntries(
        Object.entries(routing.models).map(([kind, reference]) => [kind, resolve(reference)]),
      ),
    }),
  }
  if (missing.length) {
    throw new Error(`no listed model matches ${[...new Set(missing)].join(', ')}`)
  }
  return result
}

/** Caches `listProviderModels` per key (e.g. the credential id) for `ttlMs`. */
export interface ModelCatalog {
  list(key: string, provider: AiProvider): Promise<ModelListing>
}

export function modelCatalog(
  options: { ttlMs?: number; now?: () => number } & ListModelsDependencies = {},
): ModelCatalog {
  const { ttlMs = 3_600_000, now = Date.now, ...deps } = options
  const cache = new Map<string, { at: number; listing: Promise<ModelListing> }>()
  return {
    list(key, provider) {
      const cached = cache.get(key)
      if (cached && now() - cached.at < ttlMs) return cached.listing
      const listing = listProviderModels(provider, deps)
      cache.set(key, { at: now(), listing })
      listing.then(
        (result) => result.error !== undefined && cache.delete(key),
        () => cache.delete(key),
      )
      return listing
    },
  }
}

/**
 * The routing an agent of `provider` runs with — `routing` over the provider's own `model` and
 * `models` — with `@latest` references resolved by `list` (called only when there is one). Throws
 * when a reference matches no listed model, with the listing error if the API failed.
 */
export async function resolveProviderRouting(
  provider: Pick<AiProvider, 'kind' | 'options'>,
  routing: { model?: string; models?: Record<string, string> },
  list: () => Promise<ModelListing>,
): Promise<{ model?: string; models?: Record<string, string> }> {
  const parsed = parseProviderOptions(provider)
  const model = routing.model ?? parsed.model
  const models =
    routing.models || parsed.models ? { ...parsed.models, ...routing.models } : undefined
  const effective = { ...(model !== undefined && { model }), ...(models && { models }) }
  if (![model, ...Object.values(models ?? {})].some(isLatestReference)) return routing
  const listing = await list()
  try {
    return resolveLatestRouting(effective, listing.models)
  } catch (error) {
    if (listing.error === undefined) throw error
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} (${listing.error})`,
      { cause: error },
    )
  }
}
