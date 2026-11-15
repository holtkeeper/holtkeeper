import type { RepoRef } from '@holtkeeper/forge'

/** Every action a grant can allow. `*` in a grant allows all of them. */
export const actions = [
  'repos:read',
  'audits:read',
  'audits:run',
  'analyses:read',
  'analyses:run',
  'catalog:read',
  'releases:read',
  'releases:run',
  'tasks:run',
  'settings:read',
  'settings:write',
  'credentials:read',
  'credentials:write',
  'knowledge:read',
  'knowledge:write',
  'ai:read',
  'ai:admin',
  'users:read',
  'users:invite',
  'users:write',
  'audit:read',
] as const

export type Action = (typeof actions)[number]

/**
 * Which repositories something applies to. `all` covers everything, including global objects.
 * Otherwise a repository is covered when one of `teams` owns it or its path matches one of
 * `repos`. A `repos` pattern is a path glob (`*` stays within one folder, `**` crosses folders),
 * optionally prefixed with a forge id: `work:acme/**`, `acme/*\/game-frontend`. Entries combine
 * with OR.
 */
export interface Scope {
  all?: boolean
  teams?: string[]
  repos?: string[]
}

/** Allows `actions` within `scope`. */
export interface Grant {
  scope: Scope
  actions: (Action | '*')[]
}

/** Who is acting. Providers build principals; nothing else decides identity. */
export interface Principal {
  id: string
  name: string
  email?: string
  /** Name of the auth provider that produced the principal, e.g. `none`, `header`, `users`. */
  provider: string
  grants: Grant[]
  /**
   * The path patterns of the teams its grants name, so a grant on `{ teams: [key] }` also covers
   * objects scoped to paths inside the team (`scopeWithin`). Without it a team grant covers only
   * repositories and objects scoped to that team.
   */
  teamDefs?: Readonly<Record<string, TeamPatterns>>
}

/** What scope checks need of a team: the patterns it owns and those cut out of them. */
export interface TeamPatterns {
  owns: readonly string[]
  exclude?: readonly string[]
}

/** A repository with the teams that own it (see `teamsOwning`); empty when nobody does. */
export interface RepoTarget extends RepoRef {
  teams: string[]
}

/** What an action is performed on: a repository, an object owned by a scope, or the whole system. */
export type Target =
  | { kind: 'repo'; repo: RepoTarget }
  | { kind: 'scope'; scope: Scope }
  | { kind: 'global' }

export const everything: Scope = { all: true }

/** The single user of setups without accounts. */
export const rootPrincipal = (provider: string, name = 'root'): Principal => ({
  id: 'root',
  name,
  provider,
  grants: [{ scope: everything, actions: ['*'] }],
})
