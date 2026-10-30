import { type AiProviderPlugin, type CatalogProvider, parseModelsDev } from '@holtkeeper/agent'
import {
  WAIBEE_MODELS_SNAPSHOT,
  type WaibeeModel,
  createWaibee,
  listWaibeeModels,
  toModelsDev,
} from '@holtkeeper/waibee-ai-provider'

/** The `package` value of `ai-sdk` credentials that run on Waibee Router. */
export const WAIBEE_PACKAGE = '@holtkeeper/waibee-ai-provider'

export interface WaibeeOptions {
  /**
   * Key the catalog is listed with, so models and prices follow that account's plan. Default
   * `WAIBEE_API_KEY` from the environment; without one the catalog is the snapshot bundled with
   * the provider package, whose prices are approximate. Credentials bring their own key for runs.
   */
  apiKey?: string
  /** Router API root for the catalog; credentials set their own `baseUrl`. */
  baseUrl?: string
  /** Catalog provider id. Default `waibee`. */
  id?: string
  /** Replaces the live listing; for tests. */
  listModels?: () => Promise<WaibeeModel[]>
}

/**
 * Waibee Router as an AI provider plugin: `ai-sdk` credentials with `package:
 * '@holtkeeper/waibee-ai-provider'` run on it, with the credential secret as the key. Models go
 * through Chat Completions; `settings: { endpoint: 'messages' }` sends them through Anthropic
 * Messages instead. The catalog lists Waibee's chat models with prices.
 */
export function waibee(options: WaibeeOptions = {}): AiProviderPlugin {
  const id = options.id ?? 'waibee'
  const apiKey = options.apiKey ?? process.env.WAIBEE_API_KEY
  const listModels =
    options.listModels ??
    (apiKey
      ? () =>
          listWaibeeModels({
            apiKey,
            classes: ['text'],
            ...(options.baseUrl && { baseURL: options.baseUrl }),
          })
      : async () => WAIBEE_MODELS_SNAPSHOT.models)

  return {
    package: WAIBEE_PACKAGE,
    languageModel(connection, modelId) {
      const provider = createWaibee({
        apiKey: connection.secret,
        ...(connection.baseUrl && { baseURL: connection.baseUrl }),
        ...(connection.headers && { headers: connection.headers }),
      })
      return connection.settings?.['endpoint'] === 'messages'
        ? provider.messages(modelId)
        : provider.chat(modelId)
    },
    async catalog(): Promise<CatalogProvider[]> {
      const entry = toModelsDev(await listModels(), {
        id,
        ...(options.baseUrl && { baseURL: options.baseUrl }),
      })
      return parseModelsDev({ [id]: entry })
    },
  }
}
