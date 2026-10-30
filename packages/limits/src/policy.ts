import { z } from 'zod'

/** How a limiter retries and cools down after a rate-limit answer. */
export interface BackoffPolicy {
  /** HTTP statuses that mean "slow down", e.g. `[429]`. */
  onStatus: number[]
  /** First cool-down when the answer has no usable reset header; doubles per repeated throttle. */
  baseMs: number
  /** Longest cool-down, also the cap for server-provided reset hints. */
  maxMs: number
}

/**
 * Limits shared by every user of one credential. Omitted fields are unlimited. Rates are token
 * buckets that refill continuously; daily caps reset at UTC midnight.
 */
export interface LimitPolicy {
  /** Leases held at the same time (requests in flight, agent runs). */
  maxConcurrent?: number
  /** Request units per minute. */
  requestsPerMinute?: number
  /** AI tokens per minute (input + output + cache writes). */
  tokensPerMinute?: number
  /** AI tokens per UTC day; reaching it denies new leases with `LimitExceededError`. */
  tokensPerDay?: number
  /** USD per UTC day; reaching it denies new leases with `LimitExceededError`. */
  costPerDayUsd?: number
  /** Request units that may be spent at once; default `requestsPerMinute`. */
  burst?: number
  backoff?: BackoffPolicy
}

const positive = z.number().positive()

export const backoffPolicySchema = z.object({
  onStatus: z.array(z.number().int().min(100).max(599)).min(1),
  baseMs: z.number().int().positive(),
  maxMs: z.number().int().positive(),
})

/** Validates a `LimitPolicy`; unknown fields are rejected so typos do not silently disable limits. */
export const limitPolicySchema: z.ZodType<LimitPolicy> = z.strictObject({
  maxConcurrent: z.number().int().positive().optional(),
  requestsPerMinute: positive.optional(),
  tokensPerMinute: positive.optional(),
  tokensPerDay: positive.optional(),
  costPerDayUsd: positive.optional(),
  burst: z.number().int().positive().optional(),
  backoff: backoffPolicySchema.optional(),
})

/**
 * The `limits.credentials` setting, shaped like `SettingDefinition` from `@holtkeeper/settings` so
 * it can be registered there without this package depending on it. Keys are credential ids or
 * names; an id entry wins over a name entry.
 */
export const limitsCredentialsSetting = {
  key: 'limits.credentials',
  label: 'Credential limits',
  description:
    'Concurrency, request and token rates, daily token and cost caps per credential id or name. Jobs sharing a credential share its limits; unset fields keep the defaults for the credential kind.',
  section: 'Runtime',
  schema: z.record(z.string().min(1), limitPolicySchema),
}

/** What policy resolution needs to know about a credential; `CredentialView` satisfies it. */
export interface LimitedCredential {
  id: string
  name?: string
  kind: string
  options?: Record<string, unknown>
}

export const DEFAULT_BACKOFF: BackoffPolicy = { onStatus: [429], baseMs: 1000, maxMs: 60_000 }

const AI_KINDS = new Set(['ai', 'anthropic'])

const numberAt = (options: Record<string, unknown> | undefined, field: string) => {
  const direct = options?.[field]
  if (typeof direct === 'number' && direct > 0) return direct
  const nested = options?.limits
  if (nested === null || typeof nested !== 'object' || !(field in nested)) return undefined
  const value: unknown = Reflect.get(nested, field)
  return typeof value === 'number' && value > 0 ? value : undefined
}

/**
 * Defaults per credential kind: GitLab tokens get 8 concurrent requests and 300 per minute; AI
 * keys (`ai`, `anthropic`) get 3 concurrent runs and `tokensPerMinute` from the credential's
 * options (`options.tokensPerMinute` or `options.limits.tokensPerMinute`) when known. Other kinds
 * are unlimited apart from backing off after 429.
 */
export function defaultLimitPolicy(credential: LimitedCredential): LimitPolicy {
  if (credential.kind === 'gitlab') {
    return { maxConcurrent: 8, requestsPerMinute: 300, backoff: DEFAULT_BACKOFF }
  }
  if (AI_KINDS.has(credential.kind)) {
    const tokensPerMinute = numberAt(credential.options, 'tokensPerMinute')
    return {
      maxConcurrent: 3,
      ...(tokensPerMinute !== undefined && { tokensPerMinute }),
      backoff: { ...DEFAULT_BACKOFF, onStatus: [429, 529] },
    }
  }
  return { backoff: DEFAULT_BACKOFF }
}

/**
 * The effective policy of a credential: kind defaults, overridden field by field by the
 * `limits.credentials` entry for its id (or, without one, its name).
 */
export function resolveLimitPolicy(
  credential: LimitedCredential,
  configured?: Record<string, LimitPolicy>,
): LimitPolicy {
  const override =
    configured?.[credential.id] ??
    (credential.name === undefined ? undefined : configured?.[credential.name])
  return { ...defaultLimitPolicy(credential), ...override }
}
