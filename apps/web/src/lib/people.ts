import type { CrossTeamLevel, PersonView, Scope, UserView } from '@holtkeeper/api'

import { formatRelative } from './format.ts'
import { type RoleId, roleOf } from './roles.ts'
import { formatGroupMatch } from './scope.ts'

/** Up to two initials of a name, `?` when it has none. */
export const initialsOf = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase() || '?'

/** Generated avatar of an id that is not a known user, e.g. a service account. */
export const avatarOf = (seed: string): string => `/api/avatars/${encodeURIComponent(seed)}.svg`

/** How an actor or a person named by id is shown: the user's name and avatar, else the raw id. */
export const personOf = (
  people: Readonly<Record<string, PersonView>>,
  id: string,
): PersonView & { known: boolean } => {
  const person = people[id]
  return person ? { ...person, known: true } : { name: id, avatarUrl: avatarOf(id), known: false }
}

/** Where a person stands: signing in, invited and not signed in yet, or switched off. */
export type UserStatus = 'active' | 'invited' | 'disabled'

/** A person's `UserStatus`: disabled wins over a pending invite. */
export const userStatusOf = (user: UserView): UserStatus =>
  user.disabled ? 'disabled' : user.invite ? 'invited' : 'active'

/** Words for every `UserStatus`. */
export const userStatusLabels: Readonly<Record<UserStatus, string>> = {
  active: 'Active',
  invited: 'Invited',
  disabled: 'Disabled',
}

/** The tag tone of every `UserStatus`. */
export const userStatusTone = {
  active: 'success',
  invited: 'info',
  disabled: 'default',
} as const satisfies Record<UserStatus, string>

/** How a person signs in: passkeys, single sign-on, both, or nothing yet. */
export type SignInKind = 'passkey' | 'sso' | 'both' | 'none'

/** The `SignInKind` of a person's registered passkeys and linked identities. */
export function signInKindOf(user: UserView): SignInKind {
  const passkeys = user.passkeys.length > 0
  const sso = user.identities.length > 0
  return passkeys && sso ? 'both' : passkeys ? 'passkey' : sso ? 'sso' : 'none'
}

/** `Passkey · 2`, `SSO · corp`, `Passkey and SSO` or `No passkey yet`. */
export function signInLabel(user: UserView): string {
  const kind = signInKindOf(user)
  if (kind === 'passkey') return `Passkey · ${user.passkeys.length}`
  if (kind === 'sso')
    return `SSO · ${[...new Set(user.identities.map((i) => i.provider))].join(', ')}`
  if (kind === 'both') return 'Passkey and SSO'
  return 'No passkey yet'
}

/** The quiet line under a status: when an invite runs out, or that it already did. */
export function statusNote(user: UserView, now: Date): string | undefined {
  if (user.disabled || !user.invite) return undefined
  return user.invite.expired
    ? 'Link expired · send a new one'
    : `Link expires ${formatRelative(user.invite.expiresAt, now)}`
}

/** `just now`, `3 hours ago` or `Never`. */
export const lastSeenLabel = (user: UserView, now: Date): string =>
  user.lastSeenAt ? formatRelative(user.lastSeenAt, now) : 'Never'

/** `All repositories`, `Group Web`, `Web, Payments +1`, or `Nothing` for a scope. */
export function scopeLabel(scope: Scope): string {
  if (scope.all) return 'All repositories'
  const parts = [...(scope.groups ?? []).map(formatGroupMatch), ...(scope.repos ?? [])]
  const [only] = parts
  if (parts.length === 0 || only === undefined) return 'Nothing'
  if (parts.length === 1) return scope.groups?.length ? `Group ${only}` : only
  return parts.length > 2
    ? `${parts.slice(0, 2).join(', ')} +${parts.length - 2}`
    : parts.join(', ')
}

/** What the People table filters by; empty lists match everyone. */
export interface PeopleFilter {
  query: string
  roles: readonly string[]
  teams: readonly string[]
  signIn: readonly SignInKind[]
  statuses: readonly UserStatus[]
}

/** The filter People opens with: everyone who is active or invited. */
export const defaultPeopleFilter: PeopleFilter = {
  query: '',
  roles: [],
  teams: [],
  signIn: [],
  statuses: ['active', 'invited'],
}

/** Whether a person passes the filter; the query matches name, email and teams. */
export function matchesPeople(user: UserView, filter: PeopleFilter): boolean {
  const query = filter.query.trim().toLowerCase()
  const teams = user.teams ?? []
  if (
    query &&
    ![user.name, user.email ?? '', ...teams].some((text) => text.toLowerCase().includes(query))
  )
    return false
  if (filter.roles.length && !filter.roles.includes(roleOf(user.grants).role)) return false
  if (filter.teams.length && !teams.some((team) => filter.teams.includes(team))) return false
  if (filter.signIn.length && !filter.signIn.includes(signInKindOf(user))) return false
  if (filter.statuses.length && !filter.statuses.includes(userStatusOf(user))) return false
  return true
}

/** Every team among the people, sorted. */
export const teamOptions = (users: readonly UserView[]): string[] =>
  [...new Set(users.flatMap((user) => user.teams ?? []))].toSorted((a, b) => a.localeCompare(b))

/** How many people hold each role. */
export function roleCounts(users: readonly UserView[]): Record<RoleId, number> {
  const counts: Record<RoleId, number> = {
    viewer: 0,
    developer: 0,
    maintainer: 0,
    admin: 0,
    custom: 0,
    none: 0,
  }
  for (const user of users) if (!user.disabled) counts[roleOf(user.grants).role] += 1
  return counts
}

/** The `access.crossTeam` levels, narrowest first, with what each one actually lets people read. */
export const reachLevels: readonly {
  level: CrossTeamLevel
  label: string
  description: string
}[] = [
  {
    level: 'off',
    label: 'Own teams only',
    description:
      "Only the repositories a person's grants cover. Agents working without an asker stay within the teams of the repository they work on.",
  },
  {
    level: 'metadata',
    label: 'Catalog of every team',
    description:
      'Anyone who reads some repository also reads every repository’s packages and versions, public API, stack, usage counts and notes marked shared. No code.',
  },
  {
    level: 'snippets',
    label: 'Catalog and usage code of every team',
    description:
      'The catalog plus the code of how other teams use a package: usages and upgrade call sites.',
  },
]
