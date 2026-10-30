import type { RepoRef } from '@holtkeeper/forge'

/** Every action a grant can allow. `*` in a grant allows all of them. */
export const actions = [
  'repos:read',
  'audits:read',
  'audits:run',
  'audits:allowlist',
  'analyses:read',
  'analyses:run',
  'releases:read',
  'releases:run',
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
 * Otherwise a repository is covered when it belongs to one of `groups` or its path matches one of
 * `repos`. A `repos` pattern is a path glob, optionally prefixed with a forge id: `work:games/**`.
 */
export interface Scope {
  all?: boolean
  groups?: string[]
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
}

/** A repository with the groups the config puts it in. */
export interface RepoTarget extends RepoRef {
  groups: string[]
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
