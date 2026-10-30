import { z } from 'zod'

import type { AgentUsage } from './types.ts'

/** Provider kinds an AI provider credential may have. */
export const AI_PROVIDER_KINDS = [
  'anthropic',
  'anthropic-compatible',
  'bedrock',
  'vertex',
  'openai-compatible',
] as const

export type AiProviderKind = (typeof AI_PROVIDER_KINDS)[number]

/** Whether a credential kind is one of `AI_PROVIDER_KINDS`. */
export const isAiProviderKind = (kind: string): kind is AiProviderKind =>
  (AI_PROVIDER_KINDS as readonly string[]).includes(kind)

/** Prices in USD per million tokens of one model. */
export const modelPricingSchema = z.object({
  inputPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
  cacheReadPerMTok: z.number().nonnegative().optional(),
  cacheWritePerMTok: z.number().nonnegative().optional(),
})

export type ModelPricing = z.infer<typeof modelPricingSchema>

const httpUrl = z.url({ protocol: /^https?$/ })
const headerName = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, 'invalid header name')
const headerValue = z.string().refine((value) => !/[\r\n]/.test(value), 'no line breaks')

const common = {
  /** Default model for tasks whose kind has no entry in `models`. */
  model: z.string().min(1).optional(),
  /** Model per task kind, e.g. `{ review: 'claude-opus-5-5', triage: 'claude-haiku-5-5' }`. */
  models: z.record(z.string().min(1), z.string().min(1)).optional(),
  /** Logical model id → the name the provider knows it by, e.g. `{ 'claude-opus-5-5': 'opus' }`. */
  modelMap: z.record(z.string().min(1), z.string().min(1)).optional(),
  /** Prices per model (logical or provider name) for cost when the provider reports none. */
  pricing: z.record(z.string().min(1), modelPricingSchema).optional(),
  /** Timeout of one model request. */
  timeoutMs: z.number().int().positive().optional(),
  /** Tasks this provider runs at the same time; more wait in line. */
  maxConcurrency: z.number().int().positive().optional(),
}

const credentialsSource = z.enum(['env', 'secret']).default('env')

/**
 * Provider configuration, discriminated by `kind`. It is what an AI provider credential stores in
 * `options` (plus the credential's `kind`); the endpoint defaults to the credential's `url`.
 */
export const providerOptionsSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('anthropic'),
    ...common,
    baseUrl: httpUrl.optional(),
  }),
  z.object({
    kind: z.literal('anthropic-compatible'),
    ...common,
    baseUrl: httpUrl.optional(),
    /** How the secret is sent: `x-api-key: <secret>` or `Authorization: Bearer <secret>`. */
    authHeader: z.enum(['x-api-key', 'bearer']).default('x-api-key'),
    /** Extra request headers; `{secret}` in a value is replaced by the credential secret. */
    headers: z.record(headerName, headerValue).optional(),
  }),
  z.object({
    kind: z.literal('bedrock'),
    ...common,
    region: z.string().min(1),
    baseUrl: httpUrl.optional(),
    /**
     * `env` (default): AWS credentials from the server environment. `secret`: the secret is a
     * Bedrock API key, or JSON `{ accessKeyId, secretAccessKey, sessionToken? }`.
     */
    credentials: credentialsSource,
  }),
  z.object({
    kind: z.literal('vertex'),
    ...common,
    region: z.string().min(1),
    projectId: z.string().min(1),
    baseUrl: httpUrl.optional(),
    /** `env` (default): Google application default credentials. `secret`: a service account key JSON. */
    credentials: credentialsSource,
  }),
  z.object({
    kind: z.literal('openai-compatible'),
    ...common,
    baseUrl: httpUrl.optional(),
    /** Extra request headers; `{secret}` in a value is replaced by the credential secret. */
    headers: z.record(headerName, headerValue).optional(),
    /** The endpoint must support tool calling; agents cannot work without it. */
    supportsTools: z
      .boolean()
      .default(true)
      .refine((value) => value, 'the provider must support tool calling'),
    /** Send `response_format: { type: 'json_object' }` for tasks with structured output. */
    jsonMode: z.boolean().optional(),
  }),
])

export type ProviderOptions = z.infer<typeof providerOptionsSchema>
export type ProviderOptionsInput = z.input<typeof providerOptionsSchema>

/** An AI provider as stored in a credential: kind, endpoint, plaintext secret and options. */
export interface AiProvider {
  kind: string
  url: string
  secret: string
  options?: Record<string, unknown>
}

/** The provider's issues as `field: message` strings, or `[]` when the options are valid. */
export function providerOptionsIssues(kind: string, options: unknown): string[] {
  if (!isAiProviderKind(kind)) return [`kind: ${kind} is not an AI provider kind`]
  const value = typeof options === 'object' && options !== null ? options : {}
  const result = providerOptionsSchema.safeParse({ ...value, kind })
  return result.success
    ? []
    : result.error.issues.map(
        (issue) => `${['options', ...issue.path].join('.')}: ${issue.message}`,
      )
}

/** Parses a provider's options with its kind; throws listing every problem. */
export function parseProviderOptions(
  provider: Pick<AiProvider, 'kind' | 'options'>,
): ProviderOptions {
  const issues = providerOptionsIssues(provider.kind, provider.options)
  if (issues.length) throw new Error(`invalid AI provider: ${issues.join('; ')}`)
  return providerOptionsSchema.parse({ ...provider.options, kind: provider.kind })
}

/** The provider's name for a logical model id: its `modelMap` entry, or the id itself. */
export const mapModel = (model: string, modelMap?: Record<string, string>): string =>
  modelMap?.[model] ?? model

/** `headers` with every `{secret}` replaced by `secret`. */
export function renderHeaders(
  headers: Record<string, string> | undefined,
  secret: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers ?? {}).map(([name, value]) => [
      name,
      value.replaceAll('{secret}', secret),
    ]),
  )
}

const perToken = (perMTok: number) => perMTok / 1_000_000

/**
 * Cost of `usage` at `pricing`, looked up by any of `models` (first match wins); `undefined` when
 * none of them is priced. Cache tokens without a cache price are charged as input.
 */
export function costFromPricing(
  usage: AgentUsage,
  pricing: Record<string, ModelPricing> | undefined,
  ...models: (string | undefined)[]
): number | undefined {
  const price = models.map((model) => (model ? pricing?.[model] : undefined)).find(Boolean)
  if (!price) return undefined
  return (
    usage.inputTokens * perToken(price.inputPerMTok) +
    usage.outputTokens * perToken(price.outputPerMTok) +
    usage.cacheReadTokens * perToken(price.cacheReadPerMTok ?? price.inputPerMTok) +
    usage.cacheWriteTokens * perToken(price.cacheWritePerMTok ?? price.inputPerMTok)
  )
}

/**
 * A credential options validator (`CredentialOptionsValidator` of `@holtkeeper/credentials`):
 * `providerOptionsIssues` for AI provider kinds, `undefined` for every other kind.
 */
export const aiProviderOptionsValidator = (
  kind: string,
  options: Record<string, unknown> | undefined,
): string[] | undefined =>
  isAiProviderKind(kind) ? providerOptionsIssues(kind, options) : undefined
