import type { ConfigEntryView, PutConfigInput } from '@holtkeeper/api'

import { validateGroupId } from '../../lib/repo.ts'

/** What the forge dialog edits. */
export interface ForgeDraft {
  id: string
  url: string
  credentialId: string
}

export type ForgeDraftErrors = Partial<Record<keyof ForgeDraft, string>>

export const toForgeDraft = (forge?: ConfigEntryView<'forge'>): ForgeDraft => ({
  id: forge?.id ?? '',
  url: forge?.data.url ?? '',
  credentialId: forge?.data.credentialId ?? '',
})

/** Problems by field; `taken` are ids a new forge must not reuse. */
export function validateForgeDraft(draft: ForgeDraft, taken: readonly string[]): ForgeDraftErrors {
  const errors: ForgeDraftErrors = {}
  const id = draft.id.trim()
  const idError = validateGroupId(id)
  if (idError) errors.id = idError
  else if (taken.includes(id)) errors.id = 'A forge with this id exists'
  if (!URL.canParse(draft.url.trim()) || !/^https?:/.test(draft.url.trim()))
    errors.url = 'An http(s) URL'
  if (!draft.credentialId) errors.credentialId = 'Choose the token credential'
  return errors
}

/** The `PUT /api/config/forges/:id` body; only GitLab has a panel adapter. */
export const toForgeInput = (draft: ForgeDraft): PutConfigInput['forge'] => ({
  kind: 'gitlab',
  url: draft.url.trim().replace(/\/+$/, ''),
  credentialId: draft.credentialId,
})
