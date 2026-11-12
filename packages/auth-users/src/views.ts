import type { Grant, Role } from '@holtkeeper/access'
import type { ExternalAccount, Timestamp, User } from '@holtkeeper/store'

import { type PeopleDeps, creatorOf, hasSignedIn, inviteOf, teamsOf } from './people.ts'

/** Matches `PersonView` in `@holtkeeper/api`. */
export interface PersonView {
  name: string
  avatarUrl: string
}

/** Matches `UserInviteView` in `@holtkeeper/api`. */
export interface UserInviteView {
  createdAt?: Timestamp
  expiresAt: Timestamp
  expired: boolean
  createdBy?: string
}

/** Matches `PeopleSummary` in `@holtkeeper/api`. */
export interface PeopleSummary {
  total: number
  active: number
  invited: number
  disabled: number
  admins: number
  withoutSignIn: number
  signIn: string[]
}

/** A user as the admin API returns it; matches `UserView` in `@holtkeeper/api`. */
export interface UserView {
  id: string
  name: string
  email?: string
  grants: Grant[]
  disabled: boolean
  createdAt: Timestamp
  createdBy?: string
  /** The user behind `createdBy`, when it names one. */
  creator?: PersonView
  passkeys: { id: string; label?: string; createdAt: Timestamp; lastUsedAt?: Timestamp }[]
  identities: { provider: string; email?: string }[]
  /** `/api/avatars/<seed>.svg`; the seed is `avatarSeed` or the user id. */
  avatarUrl: string
  lastSeenAt?: Timestamp
  /** The newest enrollment link while the user has never signed in. */
  invite?: UserInviteView
  /** Their home groups, else the groups their grants name. */
  teams: string[]
}

/** An external account without its challenge hash; matches `ExternalAccountView` in `@holtkeeper/api`. */
export interface ExternalAccountView {
  id: string
  userId: string
  provider: string
  externalId: string
  username?: string
  verification: ExternalAccount['verification']
  linkedBy: string
  linkedAt: Timestamp
  verifiedAt?: Timestamp
  /** When the pending challenge code expires. */
  challengeExpiresAt?: Timestamp
}

/** Matches `ExternalAccountList` in `@holtkeeper/api`. */
export interface ExternalAccountList {
  accounts: ExternalAccountView[]
}

export const toAccountView = (account: ExternalAccount): ExternalAccountView => ({
  id: account.id,
  userId: account.userId,
  provider: account.provider,
  externalId: account.externalId,
  ...(account.username !== undefined && { username: account.username }),
  verification: account.verification,
  linkedBy: account.linkedBy,
  linkedAt: account.linkedAt,
  ...(account.verifiedAt !== undefined && { verifiedAt: account.verifiedAt }),
  ...(account.challenge && { challengeExpiresAt: account.challenge.expiresAt }),
})

/** Where the server renders the avatar for a seed. */
const avatarUrl = (seed: string) => `/api/avatars/${encodeURIComponent(seed)}.svg`

const avatarOf = (user: User) => avatarUrl(user.avatarSeed ?? user.id)

/** Matches `LinkResponse` in `@holtkeeper/api`. */
export interface LinkResponse {
  user: UserView
  link: string
  expiresAt: Timestamp
}

/** Matches `LinkRole` in `@holtkeeper/api`. */
export type LinkRole = Role

/** Matches `LinkInfo` in `@holtkeeper/api`. */
export interface LinkInfo {
  purpose: 'enroll' | 'recover'
  userName: string
  expiresAt: Timestamp
  grants: { count: number; role: LinkRole }
}

/** Matches `LinkGone` in `@holtkeeper/api`. */
export interface LinkGone {
  error: string
  state: 'used' | 'expired'
  at: Timestamp
}

export async function toUserView(deps: PeopleDeps, user: User): Promise<UserView> {
  const { store } = deps
  const [passkeys, identities, creator, teams, signedIn] = await Promise.all([
    store.listPasskeys(user.id),
    store.listIdentities(user.id),
    creatorOf(store, user.createdBy, avatarOf),
    teamsOf(deps, user),
    hasSignedIn(store, user),
  ])
  const invite = await inviteOf(deps, user, signedIn)
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    grants: user.grants,
    disabled: user.disabled,
    createdAt: user.createdAt,
    createdBy: user.createdBy,
    ...(creator && { creator }),
    passkeys: passkeys
      .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(({ id, label, createdAt, lastUsedAt }) => ({ id, label, createdAt, lastUsedAt })),
    identities: identities.map(({ provider, email }) => ({ provider, email })),
    avatarUrl: avatarOf(user),
    ...(user.lastSeenAt && { lastSeenAt: user.lastSeenAt }),
    ...(invite && { invite }),
    teams,
  }
}

/** Matches `UserList` in `@holtkeeper/api`. */
export interface UserList {
  users: UserView[]
}
