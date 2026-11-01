import type { Action, Grant, Scope, UserView } from '@holtkeeper/api'

import { describeScope, normalizeScope } from './scope.ts'

/** Node id of a scope: `scope:<describeScope text>`. */
const scopeNode = (scope: Scope): string => `scope:${describeScope(normalizeScope(scope))}`

/** `all actions`, `read only` or `5 actions`. */
export function describeActions(actions: readonly (Action | '*')[]): string {
  if (actions.includes('*')) return 'all actions'
  if (actions.length && actions.every((action) => action.endsWith(':read'))) return 'read only'
  return `${actions.length} action${actions.length === 1 ? '' : 's'}`
}

/** What the access map draws: users, the scopes they hold grants in, and those grants. */
export interface AccessMap {
  users: { id: string; userId: string; name: string; avatarUrl: string; disabled: boolean }[]
  scopes: { id: string; label: string; scope: Scope; idle: boolean }[]
  /** One per user and scope; several grants on one scope are merged. */
  edges: { from: string; to: string; actions: (Action | '*')[]; label: string }[]
}

/**
 * Users linked to the scopes of their grants. `groups` add a scope per config group, and
 * everything is always offered, so an editor can grant there; scopes nobody holds are `idle`.
 */
export function accessMap(users: readonly UserView[], groups: readonly string[] = []): AccessMap {
  const scopes = new Map<string, AccessMap['scopes'][number]>()
  const edges = new Map<string, AccessMap['edges'][number]>()
  for (const user of users) {
    for (const grant of user.grants) {
      const scope = normalizeScope(grant.scope)
      const to = scopeNode(scope)
      if (!scopes.has(to))
        scopes.set(to, { id: to, label: describeScope(scope), scope, idle: false })
      const from = `user:${user.id}`
      const key = `${from}->${to}`
      const merged = [...new Set([...(edges.get(key)?.actions ?? []), ...grant.actions])]
      edges.set(key, { from, to, actions: merged, label: describeActions(merged) })
    }
  }
  for (const scope of [{ all: true }, ...groups.map((group) => ({ groups: [group] }))]) {
    const id = scopeNode(scope)
    if (!scopes.has(id)) scopes.set(id, { id, label: describeScope(scope), scope, idle: true })
  }
  return {
    users: users.map((user) => ({
      id: `user:${user.id}`,
      userId: user.id,
      name: user.name,
      avatarUrl: user.avatarUrl,
      disabled: user.disabled,
    })),
    scopes: [...scopes.values()].toSorted(
      (a, b) =>
        Number(Boolean(b.scope.all)) - Number(Boolean(a.scope.all)) ||
        a.label.localeCompare(b.label),
    ),
    edges: [...edges.values()],
  }
}

/** The actions a grant made by linking a user to a scope starts with. */
const linkedActions: Action[] = ['repos:read', 'audits:read']

/** `grants` plus a read-only grant on `scope`, unchanged when one on that scope exists. */
export function withGrant(grants: readonly Grant[], scope: Scope): Grant[] {
  const id = scopeNode(scope)
  if (grants.some((grant) => scopeNode(grant.scope) === id)) return [...grants]
  return [...grants, { scope: normalizeScope(scope), actions: [...linkedActions] }]
}

/** `grants` without every grant on the scope with node id `id`. */
export const withoutGrant = (grants: readonly Grant[], id: string): Grant[] =>
  grants.filter((grant) => scopeNode(grant.scope) !== id)
