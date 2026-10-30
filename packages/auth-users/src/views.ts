import type { Grant } from '@holtkeeper/access'
import type { ExternalAccount, Timestamp, User, UserStore } from '@holtkeeper/store'

/** A user as the admin API returns it; matches `UserView` in `@holtkeeper/api`. */
export interface UserView {
  id: string
  name: string
  email?: string
  grants: Grant[]
  disabled: boolean
  createdAt: Timestamp
  createdBy?: string
  passkeys: { id: string; label?: string; createdAt: Timestamp; lastUsedAt?: Timestamp }[]
  identities: { provider: string; email?: string }[]
  /** `/api/avatars/<seed>.svg`; the seed is `avatarSeed` or the user id. */
  avatarUrl: string
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

/** Matches `LinkResponse` in `@holtkeeper/api`. */
export interface LinkResponse {
  user: UserView
  link: string
  expiresAt: Timestamp
}

/** Matches `LinkInfo` in `@holtkeeper/api`. */
export interface LinkInfo {
  purpose: 'enroll' | 'recover'
  userName: string
  expiresAt: Timestamp
}

export async function toUserView(store: UserStore, user: User): Promise<UserView> {
  const passkeys = await store.listPasskeys(user.id)
  const identities = await store.listIdentities(user.id)
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    grants: user.grants,
    disabled: user.disabled,
    createdAt: user.createdAt,
    createdBy: user.createdBy,
    passkeys: passkeys
      .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(({ id, label, createdAt, lastUsedAt }) => ({ id, label, createdAt, lastUsedAt })),
    identities: identities.map(({ provider, email }) => ({ provider, email })),
    avatarUrl: avatarUrl(user.avatarSeed ?? user.id),
  }
}

/** Matches `UserList` in `@holtkeeper/api`. */
export interface UserList {
  users: UserView[]
}
