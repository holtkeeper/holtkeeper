import type {
  CreateCredentialInput,
  CredentialView,
  Scope,
  UpdateCredentialInput,
} from '@holtkeeper/api'

import { isEmptyScope, normalizeScope } from '../../lib/scope.ts'

/** Credential kinds that are AI providers, whose models the server can list. */
export const aiProviderKinds: readonly string[] = [
  'anthropic',
  'anthropic-compatible',
  'bedrock',
  'vertex',
  'openai-compatible',
  'ai-sdk',
]

/** Credential kinds the UI offers; anything else is stored as `other`. */
export const credentialKinds = [
  'gitlab',
  'github',
  'ai-sdk',
  'anthropic',
  'egress-secret',
  'other',
] as const

/** Where the egress proxy looks for an egress secret's placeholder. */
export const egressTargets = ['headers', 'url', 'body'] as const

/** Egress secret part of the form (kind `egress-secret`). */
export interface EgressDraft {
  placeholder: string
  hosts: string[]
  paths: string[]
  methods: string[]
  targets: (typeof egressTargets)[number][]
}

/** A fresh placeholder: a random UUID, which no real token looks like. */
export const newPlaceholder = (): string => crypto.randomUUID()

const emptyEgress = (): EgressDraft => ({
  placeholder: newPlaceholder(),
  hosts: [],
  paths: [],
  methods: [],
  targets: ['headers'],
})

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

function egressDraftOf(options: Record<string, unknown> | undefined): EgressDraft {
  const targets = strings(options?.in).filter((t): t is EgressDraft['targets'][number] =>
    egressTargets.some((target) => target === t),
  )
  return {
    placeholder: text(options?.placeholder) || newPlaceholder(),
    hosts: strings(options?.hosts),
    paths: strings(options?.paths),
    methods: strings(options?.methods),
    targets: targets.length ? targets : ['headers'],
  }
}

/** `options` of an egress secret credential. */
const egressOptions = (egress: EgressDraft): Record<string, unknown> => ({
  placeholder: egress.placeholder.trim(),
  ...(egress.hosts.length && { hosts: [...egress.hosts] }),
  ...(egress.paths.length && { paths: [...egress.paths] }),
  ...(egress.methods.length && { methods: egress.methods.map((m) => m.toUpperCase()) }),
  ...(egress.targets.join() !== 'headers' && { in: [...egress.targets] }),
})

/** Problem of a host entry, for the hosts input. */
export const egressHostError = (value: string): string | undefined =>
  /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(value)
    ? undefined
    : 'A host name or *.example.com'

/** Problem of a path entry, for the paths input. */
export const egressPathError = (value: string): string | undefined => {
  try {
    return RegExp(value) ? undefined : 'Not a regular expression'
  } catch {
    return 'Not a regular expression'
  }
}

/** Package for providers of your own and catalog providers without a package of their own. */
export const OPENAI_COMPATIBLE = '@ai-sdk/openai-compatible'

/** AI provider part of the form (kind `ai-sdk`). */
export interface AiDraft {
  /** Catalog provider id, or a name of your own. */
  provider: string
  /** Whether `provider` is not from the catalog. */
  custom: boolean
  package: string
  baseUrl: string
  model: string
  /** Every other option as JSON: headers, settings, models, modelMap, pricing, limits. */
  advanced: string
}

const emptyAi: AiDraft = {
  provider: '',
  custom: false,
  package: OPENAI_COMPATIBLE,
  baseUrl: '',
  model: '',
  advanced: '',
}

/** Editable state of the credential form. Numbers stay strings until submit. */
export interface CredentialDraft {
  name: string
  kind: string
  url: string
  secret: string
  expires: string
  scope: Scope
  rotation: boolean
  daysBefore: string
  lifetimeDays: string
  ai: AiDraft
  egress: EgressDraft
}

const defaultUrls: Record<string, string> = {
  'egress-secret': 'https://',
  gitlab: 'https://gitlab.com',
  github: 'https://api.github.com',
  anthropic: 'https://api.anthropic.com',
}

/** Default URL for a kind, or empty for `other`. */
export const defaultUrl = (kind: string): string => defaultUrls[kind] ?? ''

const text = (value: unknown) => (typeof value === 'string' ? value : '')

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function aiDraftOf(options: Record<string, unknown> | undefined): AiDraft {
  if (!options) return emptyAi
  const { provider, package: pkg, baseUrl, model, ...rest } = options
  return {
    provider: text(provider),
    custom: false,
    package: text(pkg) || OPENAI_COMPATIBLE,
    baseUrl: text(baseUrl),
    model: text(model),
    advanced: Object.keys(rest).length ? JSON.stringify(rest, null, 2) : '',
  }
}

/** Parses the advanced options; `undefined` when they are not a JSON object. */
function parseAdvanced(advanced: string): Record<string, unknown> | undefined {
  if (!advanced.trim()) return {}
  try {
    const value: unknown = JSON.parse(advanced)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** Form state for a new credential or an existing one (its secret is never known). */
export function toDraft(credential?: CredentialView): CredentialDraft {
  return {
    name: credential?.name ?? '',
    kind: credential?.kind ?? 'gitlab',
    url: credential?.url ?? defaultUrl('gitlab'),
    secret: '',
    expires: credential?.expiresAt?.slice(0, 10) ?? '',
    scope: credential?.scope ?? { all: true },
    rotation: credential?.rotation?.enabled ?? false,
    daysBefore: String(credential?.rotation?.daysBefore ?? 14),
    lifetimeDays: String(credential?.rotation?.lifetimeDays ?? 90),
    ai: credential?.kind === 'ai-sdk' ? aiDraftOf(credential.options) : emptyAi,
    egress:
      credential?.kind === 'egress-secret' ? egressDraftOf(credential.options) : emptyEgress(),
  }
}

const isHttpUrl = (value: string) => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

/** The credential URL of an AI provider: its base URL, else the catalog's API or docs. */
const endpointOf = (draft: CredentialDraft) =>
  draft.ai.baseUrl.trim() || draft.url.trim() || 'https://models.dev'

function validateAi(ai: AiDraft): DraftErrors {
  const errors: DraftErrors = {}
  if (!ai.provider.trim()) errors.provider = ai.custom ? 'Name the provider' : 'Choose a provider'
  if (ai.baseUrl.trim() && !isHttpUrl(ai.baseUrl.trim()))
    errors.baseUrl = 'Use an http or https URL'
  else if (ai.custom && ai.package === OPENAI_COMPATIBLE && !ai.baseUrl.trim())
    errors.baseUrl = 'An OpenAI-compatible provider needs its base URL'
  if (!parseAdvanced(ai.advanced)) errors.advanced = 'Advanced options must be a JSON object'
  return errors
}

/** Field errors of a draft by field; AI provider fields have their own keys. */
export type DraftErrors = Partial<
  Record<
    keyof CredentialDraft | 'provider' | 'baseUrl' | 'advanced' | 'placeholder' | 'targets',
    string
  >
>

/** Field errors of a draft; empty when it can be submitted. */
export function validateDraft(draft: CredentialDraft, isNew: boolean): DraftErrors {
  const errors: DraftErrors = {}
  if (!draft.name.trim()) errors.name = 'Name is required'
  if (draft.kind === 'ai-sdk') Object.assign(errors, validateAi(draft.ai))
  else {
    try {
      const url = new URL(draft.url)
      if (url.protocol !== 'https:' && url.protocol !== 'http:')
        errors.url = 'Use an http or https URL'
    } catch {
      errors.url = 'Enter a full URL, e.g. https://gitlab.example.com'
    }
  }
  if (draft.kind === 'egress-secret') {
    if (!/^[A-Za-z0-9._~-]{16,128}$/.test(draft.egress.placeholder.trim()))
      errors.placeholder = '16 to 128 letters, digits, ., _, ~ or -'
    if (!draft.egress.targets.length) errors.targets = 'Pick at least one place'
  }
  if (isNew && !draft.secret) errors.secret = 'Secret is required'
  if (isEmptyScope(draft.scope)) errors.scope = 'Choose at least one group or repository pattern'
  if (draft.rotation) {
    const before = Number(draft.daysBefore)
    const lifetime = Number(draft.lifetimeDays)
    if (!Number.isInteger(before) || before < 1) errors.daysBefore = 'Whole days, at least 1'
    if (!Number.isInteger(lifetime) || lifetime < 1) errors.lifetimeDays = 'Whole days, at least 1'
    else if (Number.isInteger(before) && before >= lifetime)
      errors.daysBefore = 'Must be shorter than the lifetime'
  }
  return errors
}

/** `options` of an AI provider credential. */
function aiOptions(ai: AiDraft): Record<string, unknown> {
  return {
    ...parseAdvanced(ai.advanced),
    provider: ai.provider.trim(),
    package: ai.package,
    ...(ai.baseUrl.trim() && { baseUrl: ai.baseUrl.trim() }),
    ...(ai.model.trim() && { model: ai.model.trim() }),
  }
}

/** Kinds the server issues replacement tokens for; GitHub has no API to issue a personal token. */
const rotatableKinds: readonly string[] = ['gitlab']

/**
 * Whether the server can rotate a credential of `kind`: what it reports for a stored credential
 * of that kind, else whether the kind is one it rotates.
 */
export const canRotate = (kind: string, credential?: Pick<CredentialView, 'kind' | 'rotatable'>) =>
  credential?.kind === kind ? credential.rotatable : rotatableKinds.includes(kind)

/** The draft as it is saved: rotation is off for kinds the server cannot rotate. */
export const savedDraft = (
  draft: CredentialDraft,
  credential?: Pick<CredentialView, 'kind' | 'rotatable'>,
): CredentialDraft => (canRotate(draft.kind, credential) ? draft : { ...draft, rotation: false })

/** Request body for `POST /api/credentials`. */
export function toCreateInput(draft: CredentialDraft): CreateCredentialInput {
  const ai = draft.kind === 'ai-sdk'
  return {
    name: draft.name.trim(),
    kind: draft.kind,
    url: ai ? endpointOf(draft) : draft.url.trim(),
    ...(ai && { options: aiOptions(draft.ai) }),
    ...(draft.kind === 'egress-secret' && { options: egressOptions(draft.egress) }),
    scope: normalizeScope(draft.scope),
    secret: draft.secret,
    ...(draft.expires ? { expiresAt: `${draft.expires}T00:00:00.000Z` } : {}),
    rotation: {
      enabled: draft.rotation,
      daysBefore: Number(draft.daysBefore) || 14,
      lifetimeDays: Number(draft.lifetimeDays) || 90,
    },
  }
}

/** Request body for `PATCH /api/credentials/:id`; an empty secret keeps the stored one. */
export function toUpdateInput(draft: CredentialDraft): UpdateCredentialInput {
  const { secret, ...input } = toCreateInput(draft)
  return secret ? { ...input, secret } : input
}

/** Catalog providers whose name or id contains `query`, best matches (name prefix) first. */
export function filterProviders<P extends { id: string; name: string }>(
  providers: readonly P[],
  query: string,
): P[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...providers]
  return providers
    .filter((p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q))
    .toSorted(
      (a, b) =>
        Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)),
    )
}

/** Models agents can use (they call tools), newest first. */
export function agentModels<M extends { id: string; toolCall?: boolean; createdAt?: string }>(
  models: readonly M[],
): M[] {
  return models
    .filter((m) => m.toolCall !== false)
    .toSorted(
      (a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || a.id.localeCompare(b.id),
    )
}
