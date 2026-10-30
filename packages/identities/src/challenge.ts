import { timingSafeEqual } from 'node:crypto'

const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** A fresh challenge code: 8 Crockford base32 characters shown as `XXXX-XXXX` (40 bits). */
export function generateChallengeCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  const chars = [...bytes].map((byte) => alphabet[byte % 32]).join('')
  return `${chars.slice(0, 4)}-${chars.slice(4)}`
}

/** Uppercase without separators, with the look-alikes `O`→`0` and `I`/`L`→`1` folded. */
export const normalizeChallengeCode = (code: string) =>
  code.toUpperCase().replaceAll(/[\s-]/g, '').replaceAll('O', '0').replaceAll(/[IL]/g, '1')

/** The stored form of a code, bound to the account it was issued for. */
export const hashChallengeCode = (accountId: string, code: string) =>
  new Bun.CryptoHasher('sha256')
    .update(`${accountId}:${normalizeChallengeCode(code)}`)
    .digest('hex')

/** Whether `code` is the one whose hash was stored for the account; constant time. */
export function challengeMatches(accountId: string, code: string, hash: string): boolean {
  const actual = Buffer.from(hashChallengeCode(accountId, code))
  const expected = Buffer.from(hash)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/** The comment or message a person posts to prove they own the account. */
export const verifyCommand = (code: string) => `/holtkeeper verify ${code}`

/**
 * The code of a `/holtkeeper verify <code>` command anywhere in a comment or chat message, or
 * `undefined` when there is none. For webhooks and bots that hand it to `completeChallenge`.
 */
export function parseVerifyCommand(text: string): string | undefined {
  const match =
    /(?:^|\s)\/holtkeeper\s+verify\s+`?([A-Za-z0-9]{4}-?[A-Za-z0-9]{4})`?(?=\s|$|[.,!])/i.exec(text)
  return match?.[1]
}
