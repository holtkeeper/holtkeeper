import type { Principal } from '@holtkeeper/access'
import type { User } from '@holtkeeper/store'

import type { Context } from './context.ts'

export const principalOf = (user: User): Principal => ({
  id: user.id,
  name: user.name,
  email: user.email,
  provider: 'users',
  grants: user.grants,
})

/** A `Set-Cookie` value signing `user` in until the session expires or its version is bumped. */
export const startSession = (ctx: Context, user: User) =>
  ctx.sessions.issue({ uid: user.id, v: user.sessionVersion })

/** The signed-in user, if the cookie is valid and the user still exists, is enabled and unchanged. */
export async function sessionUser(ctx: Context, request: Request): Promise<User | undefined> {
  const session = await ctx.sessions.read(request)
  if (!session) return undefined
  const user = await ctx.store.getUser(session.uid)
  if (!user || user.disabled || user.sessionVersion !== session.v) return undefined
  return user
}
