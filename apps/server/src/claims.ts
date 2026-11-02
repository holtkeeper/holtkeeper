import { z } from 'zod'

/** How long a link from the chat `link` command can be opened. */
export const CLAIM_TTL_SECONDS = 15 * 60

/** Where a `link` token waits to be opened in the panel; keyed by the token's SHA-256. */
export const claimKey = (token: string) =>
  `chat:claim:${new Bun.CryptoHasher('sha256').update(token).digest('hex')}`

/** What a `link` token links: the external account that asked for it. */
export const claimSchema = z.object({
  provider: z.string(),
  externalId: z.string(),
  username: z.string().optional(),
})
