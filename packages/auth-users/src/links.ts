import type { LinkToken, User, UserStore } from '@holtkeeper/store'

import { HttpError } from './errors.ts'
import { hashToken, looksLikeToken, randomToken } from './tokens.ts'
import type { LinkInfo } from './views.ts'

export interface IssuedLink {
  link: string
  expiresAt: string
}

/** Stores a new single-use link for `userId` and returns its URL; only the token hash is kept. */
export async function issueLink(
  store: UserStore,
  input: {
    origin: string
    userId: string
    purpose: LinkToken['purpose']
    ttlMs: number
    now: Date
    createdBy?: string
  },
): Promise<IssuedLink> {
  const path = input.purpose === 'login' ? '/auth/users/link/:token/login' : '/link/:token'
  const token = randomToken()
  const expiresAt = new Date(input.now.getTime() + input.ttlMs).toISOString()
  await store.putLinkToken({
    tokenHash: hashToken(token),
    userId: input.userId,
    purpose: input.purpose,
    expiresAt,
    createdBy: input.createdBy,
  })
  return { link: `${input.origin}${path.replace(':token', token)}`, expiresAt }
}

/**
 * The unused, unexpired link behind `token` and its user. Throws 404 for unknown tokens and for
 * links of other purposes, 410 for used or expired ones and 403 when the user is disabled.
 */
export async function openLink(
  store: UserStore,
  token: string,
  now: Date,
  purposes: readonly LinkToken['purpose'][] = ['enroll', 'recover'],
): Promise<{ link: LinkToken; user: User }> {
  const link = looksLikeToken(token) ? await store.getLinkToken(hashToken(token)) : undefined
  const user = link && (await store.getUser(link.userId))
  if (!link || !user || !purposes.includes(link.purpose)) throw new HttpError(404, 'link not found')
  if (link.usedAt) throw new HttpError(410, 'link has already been used')
  if (link.expiresAt <= now.toISOString()) throw new HttpError(410, 'link has expired')
  if (user.disabled) throw new HttpError(403, 'account is disabled')
  return { link, user }
}

export const linkInfo = ({ link, user }: { link: LinkToken; user: User }): LinkInfo => ({
  purpose: link.purpose === 'recover' ? 'recover' : 'enroll',
  userName: user.name,
  expiresAt: link.expiresAt,
})

export const markLinkUsed = (store: UserStore, link: LinkToken, now: Date) =>
  store.putLinkToken({ ...link, usedAt: now.toISOString() })
