import type { ExternalAccountView, LinkAccountInput } from '@holtkeeper/api'

const kindLabels: Record<string, string> = {
  gitlab: 'GitLab',
  github: 'GitHub',
  slack: 'Slack',
}

/** Display name of a provider kind: `gitlab` → `GitLab`. */
const providerKindLabel = (kind: string): string =>
  kindLabels[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1)

/** Splits `gitlab:work` into kind and instance. */
export function splitProvider(provider: string): { kind: string; instance?: string } {
  const separator = provider.indexOf(':')
  return separator < 0
    ? { kind: provider }
    : { kind: provider.slice(0, separator), instance: provider.slice(separator + 1) }
}

/** `GitLab · work` for `gitlab:work`. */
export function providerLabel(provider: string): string {
  const { kind, instance } = splitProvider(provider)
  return instance ? `${providerKindLabel(kind)} · ${instance}` : providerKindLabel(kind)
}

/** Whether the provider links accounts by numeric user id (GitLab, GitHub). */
export const numericIdProvider = (provider: string): boolean =>
  ['gitlab', 'github'].includes(splitProvider(provider).kind)

/** Provider choices for forges of the panel: `gitlab:<id>` / `github:<id>`. */
export function forgeProviders(
  forges: readonly { id: string; kind: string }[],
): { id: string; label: string }[] {
  return forges
    .filter((forge) => forge.kind === 'gitlab' || forge.kind === 'github')
    .map((forge) => {
      const id = `${forge.kind}:${forge.id}`
      return { id, label: providerLabel(id) }
    })
}

/** Label, tone and meaning of a verification level. */
export function verificationLabel(verification: ExternalAccountView['verification']): {
  text: string
  tone: 'success' | 'warning'
  description: string
} {
  switch (verification) {
    case 'admin':
      return { text: 'Verified by admin', tone: 'success', description: 'An admin vouched for it' }
    case 'oidc':
      return {
        text: 'Verified by sign-in',
        tone: 'success',
        description: 'Proven by signing in through this forge',
      }
    case 'challenge':
      return {
        text: 'Verified by code',
        tone: 'success',
        description: 'Proven by posting a one-time code from the account',
      }
    default:
      return {
        text: 'Unverified',
        tone: 'warning',
        description: 'Bots and webhooks ignore this link until it is verified',
      }
  }
}

/** Whether a pending verification code is still valid at `now`. */
export const challengePending = (account: ExternalAccountView, now: Date = new Date()): boolean =>
  account.verification === 'unverified' &&
  account.challengeExpiresAt !== undefined &&
  new Date(account.challengeExpiresAt).getTime() > now.getTime()

/** What the link form edits. */
export interface LinkDraft {
  provider: string
  externalId: string
  username: string
}

/** Errors of a link draft by field; empty when it can be sent. */
export function validateLinkDraft(draft: LinkDraft): Partial<Record<keyof LinkDraft, string>> {
  const errors: Partial<Record<keyof LinkDraft, string>> = {}
  const provider = draft.provider.trim()
  const externalId = draft.externalId.trim()
  if (!provider) errors.provider = 'Choose or type a provider'
  else if (!/^[a-z][a-z0-9-]*(:[^\s:]+)?$/.test(provider))
    errors.provider = 'Like gitlab:<forge id> or slack:<workspace>'
  if (!externalId) errors.externalId = 'Enter the account id'
  else if (provider && numericIdProvider(provider) && !/^\d+$/.test(externalId))
    errors.externalId = 'The numeric user id, not the username'
  return errors
}

/** The request body for a link draft. */
export function toLinkInput(draft: LinkDraft): LinkAccountInput {
  const username = draft.username.trim().replace(/^@/, '')
  return {
    provider: draft.provider.trim(),
    externalId: draft.externalId.trim(),
    ...(username ? { username } : {}),
  }
}
