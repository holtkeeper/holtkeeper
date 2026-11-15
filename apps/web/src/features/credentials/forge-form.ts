import type { ConfigEntryView, PutConfigInput } from '@holtkeeper/api'

import { validateConfigId } from '../../lib/repo.ts'
import { validateRootedPattern } from '../../lib/scope.ts'

/** What the forge dialog edits. */
export interface ForgeDraft {
  id: string
  url: string
  credentialId: string
  packages: boolean
  /** Only takes effect with `packages`. */
  cachePackages: boolean
  /** Username Holtkeeper posts as; empty when unknown. */
  botUsername: string
  /** Fleet path globs on this forge (no forge prefix) besides what teams own or consume. */
  include: string[]
  /** Fleet path globs left out. */
  exclude: string[]
}

export type ForgeDraftErrors = Partial<Record<keyof ForgeDraft, string>>

/**
 * Checks a fleet pattern of a forge: a path glob without a forge prefix (the document is the
 * forge) whose first segment is literal, as the server requires.
 */
export function validateFleetPattern(pattern: string): string | undefined {
  if (pattern.includes(':')) return 'No forge prefix: the patterns apply to this forge'
  return validateRootedPattern(pattern)
}

export const toForgeDraft = (forge?: ConfigEntryView<'forge'>): ForgeDraft => ({
  id: forge?.id ?? '',
  url: forge?.data.url ?? '',
  credentialId: forge?.data.credentialId ?? '',
  packages: forge?.data.packages ?? true,
  cachePackages: forge?.data.cachePackages ?? false,
  botUsername: forge?.data.botUsername ?? '',
  include: forge?.data.include ?? [],
  exclude: forge?.data.exclude ?? [],
})

/** Problems by field; `taken` are ids a new forge must not reuse. */
export function validateForgeDraft(draft: ForgeDraft, taken: readonly string[]): ForgeDraftErrors {
  const errors: ForgeDraftErrors = {}
  const id = draft.id.trim()
  const idError = validateConfigId(id)
  if (idError) errors.id = idError
  else if (taken.includes(id)) errors.id = 'A forge with this id exists'
  if (!URL.canParse(draft.url.trim()) || !/^https?:/.test(draft.url.trim()))
    errors.url = 'An http(s) URL'
  if (!draft.credentialId) errors.credentialId = 'Choose the token credential'
  const include = draft.include.map(validateFleetPattern).find(Boolean)
  if (include) errors.include = include
  const exclude = draft.exclude.map(validateFleetPattern).find(Boolean)
  if (exclude) errors.exclude = exclude
  return errors
}

/** The `PUT /api/config/forges/:id` body; only GitLab has a panel adapter. */
export const toForgeInput = (draft: ForgeDraft): PutConfigInput['forge'] => ({
  kind: 'gitlab',
  url: draft.url.trim().replace(/\/+$/, ''),
  credentialId: draft.credentialId,
  ...(!draft.packages && { packages: false }),
  ...(draft.packages && draft.cachePackages && { cachePackages: true }),
  ...(draft.botUsername.trim() && { botUsername: draft.botUsername.trim() }),
  ...(draft.include.length > 0 && { include: draft.include.map((pattern) => pattern.trim()) }),
  ...(draft.exclude.length > 0 && { exclude: draft.exclude.map((pattern) => pattern.trim()) }),
})
