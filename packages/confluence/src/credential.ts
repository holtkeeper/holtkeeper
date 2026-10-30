import { z } from 'zod'

import { confluence, type Confluence, type ConfluenceOptions } from './confluence.ts'

/** Credential kind for Confluence sites; the secret is the API token or personal access token. */
export const CONFLUENCE_CREDENTIAL_KIND = 'confluence'

/** Non-secret `options` of a `confluence` credential. */
export type ConfluenceCredentialOptions =
  | { authKind: 'basic'; email: string; flavor?: 'cloud' | 'datacenter' }
  | { authKind: 'bearer'; flavor?: 'cloud' | 'datacenter' }

export const confluenceCredentialOptionsSchema: z.ZodType<ConfluenceCredentialOptions> =
  z.discriminatedUnion('authKind', [
    z.object({
      authKind: z.literal('basic'),
      email: z.string().trim().min(1).includes('@', { message: 'must be an email address' }),
      flavor: z.enum(['cloud', 'datacenter']).optional(),
    }),
    z.object({ authKind: z.literal('bearer'), flavor: z.enum(['cloud', 'datacenter']).optional() }),
  ])

/**
 * A `CredentialOptionsValidator` for `@holtkeeper/credentials`: checks `confluence` options and
 * returns `field: message` problems; `undefined` for other kinds.
 */
export function validateConfluenceCredentialOptions(
  kind: string,
  options: Record<string, unknown> | undefined,
): string[] | undefined {
  if (kind !== CONFLUENCE_CREDENTIAL_KIND) return undefined
  const parsed = confluenceCredentialOptionsSchema.safeParse(options ?? {})
  if (parsed.success) return []
  return parsed.error.issues.map(
    (issue) => `options.${issue.path.join('.') || '(root)'}: ${issue.message}`,
  )
}

/** The parts of a stored credential (`CredentialView` of `@holtkeeper/credentials`) this needs. */
export interface ConfluenceCredential {
  kind: string
  url: string
  options?: Record<string, unknown>
}

/**
 * Builds a Confluence source and sink from a `confluence` credential and its revealed secret.
 * Throws when the kind or options are wrong.
 */
export function confluenceFromCredential(
  credential: ConfluenceCredential,
  secret: string,
  overrides: Pick<ConfluenceOptions, 'fetch' | 'retries'> = {},
): Confluence {
  if (credential.kind !== CONFLUENCE_CREDENTIAL_KIND)
    throw new Error(`expected a ${CONFLUENCE_CREDENTIAL_KIND} credential, got ${credential.kind}`)
  const parsed = confluenceCredentialOptionsSchema.safeParse(credential.options ?? {})
  if (!parsed.success)
    throw new Error(
      `invalid confluence credential options: ${validateConfluenceCredentialOptions(credential.kind, credential.options)!.join('; ')}`,
    )
  const options = parsed.data
  return confluence({
    url: credential.url,
    auth:
      options.authKind === 'basic'
        ? { kind: 'basic', email: options.email, token: secret }
        : { kind: 'bearer', token: secret },
    ...(options.flavor ? { flavor: options.flavor } : {}),
    ...overrides,
  })
}
