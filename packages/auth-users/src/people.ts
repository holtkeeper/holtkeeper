import { type GroupMatch, groupMatchSchema, roleOf } from '@holtkeeper/access'
import type { KvStore, Timestamp, User, UserStore } from '@holtkeeper/store'
import { z } from 'zod'

import type { PeopleSummary, PersonView, UserInviteView } from './views.ts'

/** What the people views read besides the user store. */
export interface PeopleDeps {
  store: UserStore
  kv?: Pick<KvStore, 'get' | 'set'>
  now: () => Date
}

const inviteKey = (userId: string) => `users:invite:${userId}`

const inviteSchema = z.object({
  createdAt: z.string(),
  expiresAt: z.string(),
  createdBy: z.string().optional(),
})

/** Remembers the newest enrollment link of a user; without a kv store, nothing. */
export async function rememberInvite(
  deps: Pick<PeopleDeps, 'kv'>,
  userId: string,
  invite: { createdAt: Timestamp; expiresAt: Timestamp; createdBy?: string },
): Promise<void> {
  await deps.kv?.set(inviteKey(userId), invite)
}

/** Whether the user ever signed in: a passkey, a linked identity or a signed-in request. */
export async function hasSignedIn(store: UserStore, user: User): Promise<boolean> {
  if (user.lastSeenAt) return true
  const [passkeys, identities] = await Promise.all([
    store.listPasskeys(user.id),
    store.listIdentities(user.id),
  ])
  return passkeys.length > 0 || identities.length > 0
}

/** The newest enrollment link of a user who never signed in, live or expired. */
export async function inviteOf(
  deps: PeopleDeps,
  user: User,
  signedIn: boolean,
): Promise<UserInviteView | undefined> {
  if (signedIn || !deps.kv) return undefined
  const parsed = inviteSchema.safeParse(await deps.kv.get(inviteKey(user.id)))
  if (!parsed.success) return undefined
  const { createdAt, expiresAt, createdBy } = parsed.data
  return {
    createdAt,
    expiresAt,
    expired: expiresAt <= deps.now().toISOString(),
    ...(createdBy !== undefined && { createdBy }),
  }
}

const formatGroupMatch = (entry: GroupMatch) =>
  typeof entry === 'string' ? entry : entry.join(' + ')

const homeGroupsSchema = z.object({ homeGroups: z.array(groupMatchSchema).optional() })

/**
 * The user's teams: the home groups they picked (the server keeps them under `prefs:<id>` in the
 * kv store), else every group their grants name, in grant order without duplicates.
 */
export async function teamsOf(deps: PeopleDeps, user: User): Promise<string[]> {
  const stored = deps.kv ? homeGroupsSchema.safeParse(await deps.kv.get(`prefs:${user.id}`)) : null
  const picked = stored?.success ? stored.data.homeGroups : undefined
  const groups = picked ?? user.grants.flatMap((grant) => grant.scope.groups ?? [])
  return [...new Set(groups.map(formatGroupMatch))]
}

/** Counts of the users the caller may see by state, and the sign-in methods on offer. */
export async function peopleSummary(
  deps: PeopleDeps,
  users: readonly User[],
  signIn: string[],
): Promise<PeopleSummary> {
  const summary: PeopleSummary = {
    total: users.length,
    active: 0,
    invited: 0,
    disabled: 0,
    admins: 0,
    withoutSignIn: 0,
    signIn,
  }
  const states = await Promise.all(
    users.map(async (user) => {
      if (user.disabled) return { disabled: true, admin: false, noSignIn: false, invited: false }
      const [passkeys, identities] = await Promise.all([
        deps.store.listPasskeys(user.id),
        deps.store.listIdentities(user.id),
      ])
      const noSignIn = passkeys.length === 0 && identities.length === 0
      const invite = await inviteOf(deps, user, Boolean(user.lastSeenAt) || !noSignIn)
      return {
        disabled: false,
        admin: roleOf(user.grants) === 'admin',
        noSignIn,
        invited: !!invite,
      }
    }),
  )
  for (const state of states) {
    if (state.disabled) {
      summary.disabled += 1
      continue
    }
    if (state.admin) summary.admins += 1
    if (state.noSignIn) summary.withoutSignIn += 1
    if (state.invited) summary.invited += 1
    else summary.active += 1
  }
  return summary
}

/** How often a signed-in request moves `User.lastSeenAt`. */
const touchEveryMs = 60_000

/** Records a signed-in request at most once a minute per user; a failed write never fails it. */
export async function touchLastSeen(
  deps: Pick<PeopleDeps, 'store' | 'now'>,
  user: User,
): Promise<void> {
  const now = deps.now()
  const last = user.lastSeenAt ? Date.parse(user.lastSeenAt) : Number.NaN
  if (now.getTime() - last < touchEveryMs) return
  try {
    await deps.store.touchUser(user.id, now.toISOString())
  } catch {
    return
  }
}

/** The name and avatar of the person behind `createdBy`, when it names a user. */
export async function creatorOf(
  store: UserStore,
  createdBy: string | undefined,
  avatarUrl: (user: User) => string,
): Promise<PersonView | undefined> {
  const creator = createdBy ? await store.getUser(createdBy) : undefined
  return creator && { name: creator.name, avatarUrl: avatarUrl(creator) }
}
