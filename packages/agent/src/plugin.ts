import type { LanguageModel } from 'ai'

import type { AiSdkConnection } from './ai-sdk.ts'
import type { AiCatalog, CatalogProvider } from './catalog.ts'
import {
  AI_SDK_PACKAGE_NAMES,
  aiProviderOptionsValidator,
  isAiProviderKind,
  providerOptionsIssues,
} from './provider.ts'

/**
 * An AI provider added from outside, typically a community AI SDK provider package. An `ai-sdk`
 * credential whose `package` equals the plugin's `package` runs on `languageModel`; the plugin's
 * `catalog` lists the provider (and its models and prices) next to the models.dev ones, so the web
 * UI offers it, `@latest` references resolve and runs are priced without further wiring.
 */
export interface AiProviderPlugin {
  /** The credential's `package` value, e.g. the npm name `waibee-ai-provider`. Unique. */
  package: string
  /** The language model `modelId` for a credential: its secret, base URL, headers and settings. */
  languageModel(connection: AiSdkConnection, modelId: string): LanguageModel
  /**
   * Catalog entries for the provider, each with `package` set to this plugin's `package`. Called
   * when the catalog is read and cached like it; a failure leaves the plugin out of the catalog
   * until it succeeds, without affecting other providers.
   */
  catalog?(): Promise<CatalogProvider[]> | CatalogProvider[]
}

/** `plugin` as given; a typed helper for writing plugins. */
export const defineAiProvider = (plugin: AiProviderPlugin): AiProviderPlugin => plugin

/** Every `ai-sdk` package name: the shipped ones, then the plugins'. */
export const aiSdkPackages = (plugins: readonly AiProviderPlugin[] = []): string[] => [
  ...AI_SDK_PACKAGE_NAMES,
  ...plugins.map((plugin) => plugin.package),
]

/**
 * A credential options validator like `aiProviderOptionsValidator` that also accepts the plugins'
 * packages and refuses any other package an `ai-sdk` credential names.
 */
export function aiProviderOptionsValidatorFor(plugins: readonly AiProviderPlugin[] = []) {
  const packages = new Set(aiSdkPackages(plugins))
  return (kind: string, options: Record<string, unknown> | undefined): string[] | undefined => {
    if (!isAiProviderKind(kind)) return undefined
    const pkg = options?.['package']
    const own = kind === 'ai-sdk' && typeof pkg === 'string' && packages.has(pkg)
    return own ? providerOptionsIssues(kind, options) : aiProviderOptionsValidator(kind, options)
  }
}

/**
 * `base` with the plugins' providers added (a plugin's provider replaces a base one of the same
 * id). Plugin catalogs are cached for `ttlMs` (default a day); a failing one keeps its last good
 * copy, or is left out, and is reported to `onError`.
 */
export function withPluginCatalogs(
  base: AiCatalog,
  plugins: readonly AiProviderPlugin[],
  options: { ttlMs?: number; now?: () => number; onError?: (error: unknown) => void } = {},
): AiCatalog {
  const { ttlMs = 86_400_000, now = Date.now, onError = () => {} } = options
  const sources = plugins.flatMap((plugin) => (plugin.catalog ? [plugin] : []))
  if (!sources.length) return base
  const cache = new Map<AiProviderPlugin, { at: number; providers: CatalogProvider[] }>()

  const load = async (plugin: AiProviderPlugin): Promise<CatalogProvider[]> => {
    const cached = cache.get(plugin)
    if (cached && now() - cached.at < ttlMs) return cached.providers
    try {
      const providers = (await plugin.catalog?.()) ?? []
      const owned = providers.map((p) => ({ ...p, package: plugin.package }))
      cache.set(plugin, { at: now(), providers: owned })
      return owned
    } catch (error) {
      onError(error)
      return cached?.providers ?? []
    }
  }

  return {
    async providers() {
      const [added, listed] = await Promise.all([
        Promise.all(sources.map(load)).then((lists) => lists.flat()),
        base.providers().then(
          (providers) => ({ providers }),
          (error: unknown) => ({ error }),
        ),
      ])
      if ('error' in listed) {
        if (!added.length) throw listed.error
        onError(listed.error)
        return added
      }
      const ids = new Set(added.map((p) => p.id))
      return [...added, ...listed.providers.filter((p) => !ids.has(p.id))]
    },
  }
}
