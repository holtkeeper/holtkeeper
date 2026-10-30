import { z } from 'zod'

/** Provider id of accounts on a configured forge: `gitlab:<forgeId>`, `github:<forgeId>`. */
export const forgeProvider = (kind: 'gitlab' | 'github', forgeId: string) => `${kind}:${forgeId}`

/** Provider id of a Slack workspace: `slack:<workspaceId>`. */
export const slackProvider = (workspaceId: string) => `slack:${workspaceId}`

const numericKinds = new Set(['gitlab', 'github'])

/**
 * Validates what a person may type to link an account: a provider of the form `kind` or
 * `kind:instance` (lowercase kind), an external id that is numeric for GitLab and GitHub, and an
 * optional username.
 */
export const linkInputSchema = z
  .object({
    provider: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9-]{0,31}(:[A-Za-z0-9._-]{1,100})?$/, 'expected <kind> or <kind>:<id>'),
    externalId: z.string().trim().min(1).max(200),
    username: z.string().trim().min(1).max(200).optional(),
  })
  .refine(
    (input) =>
      !numericKinds.has(input.provider.split(':')[0] ?? '') || /^\d+$/.test(input.externalId),
    { path: ['externalId'], message: 'GitLab and GitHub accounts are linked by numeric user id' },
  )

/** A validated link request. */
export type LinkInput = z.infer<typeof linkInputSchema>
