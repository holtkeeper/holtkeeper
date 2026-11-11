import { type ModelListing, resolveLatestModel } from './models.ts'

/** Fixed model tiers callers ask for instead of naming a model. */
export const MODEL_TIERS = ['fast', 'main', 'deep'] as const

export type ModelTier = (typeof MODEL_TIERS)[number]

/** Reasoning effort a tier runs at, on providers that support effort. */
export type ReasoningEffort = 'low' | 'medium' | 'high'

/** What a tier resolves to: the newest model of `family` the provider lists, at `effort`. */
export interface TierSpec {
  family: string
  effort: ReasoningEffort
  /** Model used when the provider cannot list its models. */
  fallback: string
}

/** `fast` is the newest Haiku, `main` the newest Sonnet, `deep` the newest Opus. */
export const TIERS: Readonly<Record<ModelTier, TierSpec>> = {
  fast: { family: 'claude-haiku', effort: 'low', fallback: 'claude-haiku-5-5' },
  main: { family: 'claude-sonnet', effort: 'medium', fallback: 'claude-sonnet-5-5' },
  deep: { family: 'claude-opus', effort: 'high', fallback: 'claude-opus-5-5' },
}

/** Tier of tasks that ask for none. */
export const DEFAULT_TIER: ModelTier = 'main'

/** The model id each tier runs on, as the provider lists it. */
export type TierModels = Readonly<Record<ModelTier, string>>

/** Every tier on its `fallback` model. */
export const FALLBACK_TIER_MODELS: TierModels = {
  fast: TIERS.fast.fallback,
  main: TIERS.main.fallback,
  deep: TIERS.deep.fallback,
}

const NEAREST: Readonly<Record<ModelTier, readonly ModelTier[]>> = {
  deep: ['main', 'fast'],
  fast: ['main', 'deep'],
  main: ['deep', 'fast'],
}

/** Options of `resolveTierModels`. */
export interface ResolveTierOptions {
  /** Told about every tier that runs on another tier's family because its own is not listed. */
  log?: (message: string) => void
}

/**
 * The model of every tier: the newest listed model of its family (`resolveLatestModel`, so
 * vendor-prefixed ids such as `vendor/claude-sonnet-5.5` match). When the listing failed or is
 * empty, tiers fall back to `TIERS[tier].fallback`. When the provider listed models but none of a
 * tier's family, the tier takes the nearest tier that has one (deep → main → fast, fast → main →
 * deep, main → deep → fast) and `log` is told; it throws only when no tier's family is listed.
 */
export function resolveTierModels(
  listing: ModelListing,
  options: ResolveTierOptions = {},
): TierModels {
  const unlisted = listing.error !== undefined || listing.models.length === 0
  const found: Partial<Record<ModelTier, string>> = {}
  for (const tier of MODEL_TIERS) {
    const resolved = resolveLatestModel(`${TIERS[tier].family}@latest`, listing.models)
    if (resolved !== undefined) found[tier] = resolved
    else if (unlisted) found[tier] = TIERS[tier].fallback
  }
  if (!MODEL_TIERS.some((tier) => found[tier] !== undefined)) {
    throw new Error(
      `the provider lists no Claude model (${MODEL_TIERS.map((tier) => TIERS[tier].family).join(', ')})`,
    )
  }
  const pick = (tier: ModelTier): string => {
    const own = found[tier]
    if (own !== undefined) return own
    for (const other of NEAREST[tier]) {
      const model = found[other]
      if (model === undefined) continue
      options.log?.(
        `the provider lists no ${TIERS[tier].family} model, tier ${tier} runs on ${other} (${model})`,
      )
      return model
    }
    throw new Error(`no model for tier ${tier}`)
  }
  return { fast: pick('fast'), main: pick('main'), deep: pick('deep') }
}
