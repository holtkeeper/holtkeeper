import type { Principal } from '@holtkeeper/access'
import type { ExternalAccount, ExternalAccountStore, User } from '@holtkeeper/store'
import { z } from 'zod'

import { canManageUser, canSeeUser } from './admin.ts'
import type { Context } from './context.ts'
import { HttpError } from './errors.ts'
import type { ForgeIssuer, OidcProviderOptions } from './options.ts'
import { type ExternalAccountView, toAccountView } from './views.ts'

const numericKinds = new Set(['gitlab', 'github'])

/** Same rules as `linkInputSchema` in `@holtkeeper/identities`. */
export const accountLinkSchema = z
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

const trimUrl = (url: string) => url.replace(/\/+$/, '').toLowerCase()

const sameIssuer = (issuer: string, forgeUrl: string) => trimUrl(issuer) === trimUrl(forgeUrl)

/** `linkAccounts`, else `gitlab:<id>` of the GitLab forge at the issuer's URL. */
export function accountProviderFor(
  options: OidcProviderOptions,
  forges: ForgeIssuer[] = [],
): string | undefined {
  if (options.linkAccounts) return options.linkAccounts
  const forge = forges.find((f) => f.kind === 'gitlab' && sameIssuer(options.issuer, f.url))
  return forge && `gitlab:${forge.id}`
}

function accountsOf(ctx: Context): ExternalAccountStore {
  if (!ctx.accounts) throw new HttpError(501, 'external accounts are not enabled')
  return ctx.accounts
}

async function visibleUser(ctx: Context, caller: Principal, id: string): Promise<User> {
  const user = await ctx.store.getUser(id)
  if (!user || !canSeeUser(caller, user)) throw new HttpError(404, 'user not found')
  return user
}

export async function listUserAccounts(
  ctx: Context,
  caller: Principal,
  userId: string,
): Promise<ExternalAccountView[]> {
  const accounts = accountsOf(ctx)
  const user = await visibleUser(ctx, caller, userId)
  return (await accounts.listByUser(user.id)).map(toAccountView)
}

/**
 * Links an external account to a user the caller manages, verified by `admin`. A link the user
 * already has is upgraded; an unverified link of someone else is replaced; a verified link of
 * someone else is a 409.
 */
export async function linkUserAccount(
  ctx: Context,
  caller: Principal,
  userId: string,
  input: z.infer<typeof accountLinkSchema>,
): Promise<ExternalAccountView> {
  const accounts = accountsOf(ctx)
  const user = await visibleUser(ctx, caller, userId)
  if (!canManageUser(caller, user)) throw new HttpError(403, 'you may not manage this user')
  const at = ctx.now().toISOString()
  const existing = await accounts.find(input.provider, input.externalId)
  if (existing && existing.userId !== user.id && existing.verification !== 'unverified')
    throw new HttpError(409, 'this account is linked to another user; unlink it there first')
  if (existing && existing.userId !== user.id) await accounts.remove(existing.id)
  const kept = existing?.userId === user.id ? existing : undefined
  const username = input.username ?? kept?.username
  const account: ExternalAccount = {
    id: kept?.id ?? crypto.randomUUID(),
    userId: user.id,
    provider: input.provider,
    externalId: input.externalId,
    ...(username !== undefined && { username }),
    verification: 'admin',
    linkedBy: caller.id,
    linkedAt: kept?.linkedAt ?? at,
    verifiedAt: at,
  }
  await accounts.put(account)
  await ctx.log(caller.id, 'account.linked', user.id, {
    provider: account.provider,
    externalId: account.externalId,
    verification: 'admin',
  })
  return toAccountView(account)
}

export async function unlinkUserAccount(
  ctx: Context,
  caller: Principal,
  userId: string,
  accountId: string,
): Promise<void> {
  const accounts = accountsOf(ctx)
  const user = await visibleUser(ctx, caller, userId)
  if (!canManageUser(caller, user)) throw new HttpError(403, 'you may not manage this user')
  const account = await accounts.get(accountId)
  if (account?.userId !== user.id) throw new HttpError(404, 'account not found')
  await accounts.remove(account.id)
  await ctx.log(caller.id, 'account.unlinked', user.id, {
    provider: account.provider,
    externalId: account.externalId,
  })
}

/**
 * Records that `user` signed in with `subject` at an issuer that is also a forge. Never takes a
 * verified link away from another user.
 */
export async function linkOidcAccount(
  ctx: Context,
  options: OidcProviderOptions,
  user: User,
  claims: { subject: string; username?: string },
): Promise<void> {
  const provider = ctx.accountProviderFor(options.id)
  const accounts = ctx.accounts
  if (!provider || !accounts) return
  const existing = await accounts.find(provider, claims.subject)
  if (existing?.userId === user.id && existing.verification !== 'unverified') return
  if (existing && existing.userId !== user.id && existing.verification !== 'unverified') return
  if (existing) await accounts.remove(existing.id)
  const at = ctx.now().toISOString()
  const username = claims.username ?? existing?.username
  await accounts.put({
    id: crypto.randomUUID(),
    userId: user.id,
    provider,
    externalId: claims.subject,
    ...(username !== undefined && { username }),
    verification: 'oidc',
    linkedBy: `oidc:${options.id}`,
    linkedAt: at,
    verifiedAt: at,
  })
  await ctx.log(user.id, 'account.linked', user.id, {
    provider,
    externalId: claims.subject,
    verification: 'oidc',
  })
}
