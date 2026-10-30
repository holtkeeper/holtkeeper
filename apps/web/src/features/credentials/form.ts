import type {
  CreateCredentialInput,
  CredentialView,
  Scope,
  UpdateCredentialInput,
} from '@holtkeeper/api'

import { isEmptyScope, normalizeScope } from '../../lib/scope.ts'

/** Credential kinds the UI offers; anything else is stored as `other`. */
export const credentialKinds = ['gitlab', 'github', 'anthropic', 'other'] as const

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
}

const defaultUrls: Record<string, string> = {
  gitlab: 'https://gitlab.com',
  github: 'https://api.github.com',
  anthropic: 'https://api.anthropic.com',
}

/** Default URL for a kind, or empty for `other`. */
export const defaultUrl = (kind: string): string => defaultUrls[kind] ?? ''

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
  }
}

/** Field errors of a draft; empty when it can be submitted. */
export function validateDraft(
  draft: CredentialDraft,
  isNew: boolean,
): Partial<Record<keyof CredentialDraft, string>> {
  const errors: Partial<Record<keyof CredentialDraft, string>> = {}
  if (!draft.name.trim()) errors.name = 'Name is required'
  try {
    const url = new URL(draft.url)
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      errors.url = 'Use an http or https URL'
  } catch {
    errors.url = 'Enter a full URL, e.g. https://gitlab.example.com'
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

/** Request body for `POST /api/credentials`. */
export function toCreateInput(draft: CredentialDraft): CreateCredentialInput {
  return {
    name: draft.name.trim(),
    kind: draft.kind,
    url: draft.url.trim(),
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
