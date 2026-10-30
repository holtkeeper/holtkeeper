import {
  type Action,
  type Grant,
  type Principal,
  canDelegate,
  grantSchema,
  grantsWithin,
} from '@holtkeeper/access'
import type { User } from '@holtkeeper/store'
import { z } from 'zod'

import type { Context } from './context.ts'
import { HttpError } from './errors.ts'
import { issueLink } from './links.ts'
import { type LinkResponse, type UserView, toUserView } from './views.ts'

const everything: Grant[] = [{ scope: { all: true }, actions: ['*'] }]

const hasAction = (principal: Principal, action: Action) =>
  principal.grants.some((grant) => grant.actions.includes('*') || grant.actions.includes(action))

/** Whether the principal holds every action on everything. */
export const isGlobalAdmin = (principal: Principal) => grantsWithin(everything, principal.grants)

/** Users are visible to callers with `users:read` whose own grants contain the user's. */
export const canSeeUser = (caller: Principal, user: User) =>
  isGlobalAdmin(caller) ||
  (hasAction(caller, 'users:read') && grantsWithin(user.grants, caller.grants))

/** Users are managed by callers with `users:write` whose own grants contain the user's. */
export const canManageUser = (caller: Principal, user: User) =>
  isGlobalAdmin(caller) ||
  (hasAction(caller, 'users:write') && grantsWithin(user.grants, caller.grants))

const sameGrants = (a: Grant[], b: Grant[]) => JSON.stringify(a) === JSON.stringify(b)

export const inviteSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.email().optional(),
  grants: z.array(grantSchema),
})

export const updateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  email: z.email().optional(),
  grants: z.array(grantSchema).optional(),
  disabled: z.boolean().optional(),
})

export async function listUsers(ctx: Context, caller: Principal): Promise<UserView[]> {
  const users = (await ctx.store.listUsers()).filter((user) => canSeeUser(caller, user))
  users.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return Promise.all(users.map((user) => toUserView(ctx.store, user)))
}

async function ensureEmailFree(ctx: Context, email: string | undefined, userId?: string) {
  if (!email) return
  const owner = await ctx.store.findUserByEmail(email)
  if (owner && owner.id !== userId) throw new HttpError(409, 'email is already in use')
}

/** Creates a user with grants the caller may delegate and returns an enrollment link. */
export async function inviteUser(
  ctx: Context,
  caller: Principal,
  input: z.infer<typeof inviteSchema>,
): Promise<LinkResponse> {
  if (!hasAction(caller, 'users:invite') || !canDelegate(caller, input.grants)) {
    throw new HttpError(403, 'grants exceed what you may hand out')
  }
  await ensureEmailFree(ctx, input.email)
  const now = ctx.now()
  const user: User = {
    id: crypto.randomUUID(),
    name: input.name,
    email: input.email,
    grants: input.grants,
    disabled: false,
    sessionVersion: 1,
    createdAt: now.toISOString(),
    createdBy: caller.id,
  }
  await ctx.store.putUser(user)
  const link = await issueLink(ctx.store, {
    origin: ctx.origin,
    userId: user.id,
    purpose: 'enroll',
    ttlMs: ctx.linkTtlMs,
    now,
    createdBy: caller.id,
  })
  await ctx.log(caller.id, 'user.invited', user.id, { name: user.name, grants: user.grants })
  return { user: await toUserView(ctx.store, user), ...link }
}

async function managedUser(ctx: Context, caller: Principal, id: string): Promise<User> {
  const user = await ctx.store.getUser(id)
  if (!user || !canSeeUser(caller, user)) throw new HttpError(404, 'user not found')
  if (!canManageUser(caller, user)) throw new HttpError(403, 'you may not manage this user')
  return user
}

/** Applies a patch; grant or disable changes end every session of the user. */
export async function updateUser(
  ctx: Context,
  caller: Principal,
  id: string,
  input: z.infer<typeof updateSchema>,
): Promise<UserView> {
  const user = await managedUser(ctx, caller, id)
  const grantsChanged = input.grants !== undefined && !sameGrants(input.grants, user.grants)
  const disabledChanged = input.disabled !== undefined && input.disabled !== user.disabled
  if (user.id === caller.id && (grantsChanged || input.disabled === true)) {
    throw new HttpError(403, 'you may not change your own grants or disable yourself')
  }
  if (grantsChanged && input.grants && !canDelegate(caller, input.grants)) {
    throw new HttpError(403, 'grants exceed what you may hand out')
  }
  await ensureEmailFree(ctx, input.email, user.id)

  const updated: User = {
    ...user,
    name: input.name ?? user.name,
    email: input.email ?? user.email,
    grants: grantsChanged && input.grants ? input.grants : user.grants,
    disabled: input.disabled ?? user.disabled,
    sessionVersion:
      grantsChanged || disabledChanged ? user.sessionVersion + 1 : user.sessionVersion,
  }
  await ctx.store.putUser(updated)
  await ctx.log(caller.id, 'user.updated', user.id, {
    fields: Object.entries(input)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key),
  })
  if (disabledChanged)
    await ctx.log(caller.id, updated.disabled ? 'user.disabled' : 'user.enabled', user.id)
  return toUserView(ctx.store, updated)
}

/** A recovery link; using it registers a new passkey and ends the user's other sessions. */
export async function issueRecovery(
  ctx: Context,
  caller: Principal,
  id: string,
): Promise<LinkResponse> {
  const user = await managedUser(ctx, caller, id)
  const link = await issueLink(ctx.store, {
    origin: ctx.origin,
    userId: user.id,
    purpose: 'recover',
    ttlMs: ctx.linkTtlMs,
    now: ctx.now(),
    createdBy: caller.id,
  })
  await ctx.log(caller.id, 'user.recovery_issued', user.id)
  return { user: await toUserView(ctx.store, user), ...link }
}

export async function removePasskey(
  ctx: Context,
  caller: Principal,
  userId: string,
  passkeyId: string,
): Promise<void> {
  const user = await managedUser(ctx, caller, userId)
  const passkey = await ctx.store.getPasskey(passkeyId)
  if (passkey?.userId !== user.id) throw new HttpError(404, 'passkey not found')
  await ctx.store.removePasskey(passkey.id)
  await ctx.log(caller.id, 'passkey.removed', user.id, { passkey: passkey.id })
}
