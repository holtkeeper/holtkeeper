import {
  type Action,
  type Principal,
  type RepoTarget,
  type Scope,
  can,
  groupNames,
} from '@holtkeeper/access'
import type { RepoRef } from '@holtkeeper/forge'
import { type CrossTeamCatalog, crossTeamLevels, defaultCrossTeam } from '@holtkeeper/settings'
import type { KnowledgeEntry, SettingEntry, SettingStore } from '@holtkeeper/store'

/** Whether a listed repository-bound item is visible; lists filter instead of failing. */
export const canSee = (principal: Principal, action: Action, repo: RepoTarget) =>
  can(principal, action, { kind: 'repo', repo })

/** The `access.crossTeam` level of a settings list; `defaultCrossTeam` when unset or invalid. */
export function crossTeamOf(entries: readonly SettingEntry[]): CrossTeamCatalog {
  const value = entries.find(
    (entry) => entry.key === 'access.crossTeam' && entry.scope.all === true,
  )?.value
  return crossTeamLevels.find((level) => level === value) ?? defaultCrossTeam
}

/** Reads the current `access.crossTeam` level. */
export const crossTeamPolicy = async (settings: Pick<SettingStore, 'list'>) =>
  crossTeamOf(await settings.list('access.crossTeam'))

/** Whether the principal may read some repository at all: the gate of cross-team reach. */
const readsSomething = (principal: Principal): boolean =>
  principal.grants.some((grant) =>
    grant.actions.some(
      (action) =>
        action === '*' ||
        action === 'repos:read' ||
        action === 'analyses:read' ||
        action === 'catalog:read',
    ),
  )

/**
 * Whether the principal may read the catalog facts of `repo` (package inventory, public API,
 * usages, stack, shared notes): its own `catalog:read` (implied by `analyses:read`), or any read
 * grant at all while `policy` is not `off`. Never covers findings, audits, jobs or releases.
 */
export const canSeeCatalog = (
  principal: Principal,
  repo: RepoTarget,
  policy: CrossTeamCatalog,
): boolean =>
  can(principal, 'catalog:read', { kind: 'repo', repo }) ||
  (policy !== 'off' && readsSomething(principal))

/**
 * Whether the principal may read code snippets of how `repo` uses packages: its own
 * `analyses:read`, or cross-team reach under the `snippets` level.
 */
export const canSeeSnippets = (
  principal: Principal,
  repo: RepoTarget,
  policy: CrossTeamCatalog,
): boolean =>
  can(principal, 'analyses:read', { kind: 'repo', repo }) ||
  (policy === 'snippets' && readsSomething(principal))

/** What one principal may read of the catalog, with the policy it was decided under. */
export interface CatalogReach {
  policy: CrossTeamCatalog
  /** Repositories whose catalog facts the principal may read (`canSeeCatalog`). */
  catalog: (repo: RepoRef) => boolean
  /** Repositories whose usage snippets the principal may read (`canSeeSnippets`). */
  snippets: (repo: RepoRef) => boolean
}

/** `CatalogReach` of a principal under `policy`, resolving groups with `targetOf`. */
export const reachOf = (
  principal: Principal,
  policy: CrossTeamCatalog,
  targetOf: (repo: RepoRef) => RepoTarget,
): CatalogReach => ({
  policy,
  catalog: (repo) => canSeeCatalog(principal, targetOf(repo), policy),
  snippets: (repo) => canSeeSnippets(principal, targetOf(repo), policy),
})

/** Reads the policy once per call and returns the principal's `CatalogReach`. */
export const catalogReach =
  (settings: Pick<SettingStore, 'list'>, targetOf: (repo: RepoRef) => RepoTarget) =>
  async (principal: Principal): Promise<CatalogReach> =>
    reachOf(principal, await crossTeamPolicy(settings), targetOf)

/** Whether a knowledge entry is in the cross-team catalog: accepted and marked `shared`. */
export const isSharedEntry = (entry: Pick<KnowledgeEntry, 'visibility' | 'status'>): boolean =>
  entry.visibility === 'shared' && entry.status === 'accepted'

/**
 * Whether the principal may read a `shared` knowledge entry of `scope`: `catalog:read` over the
 * scope, or any read grant while `policy` is not `off`.
 */
export const canReadShared = (
  principal: Principal,
  scope: Scope,
  policy: CrossTeamCatalog,
): boolean =>
  can(principal, 'catalog:read', { kind: 'scope', scope }) ||
  (policy !== 'off' && readsSomething(principal))

/**
 * The teams an entry of `scope` belongs to: the config groups it names, plus the groups of the
 * exact repositories it names. Empty for scopes covering everything.
 */
export function scopeOwner(scope: Scope, groupsOf: (repo: RepoRef) => string[]): string[] {
  if (scope.all) return []
  const owners = new Set(groupNames(scope.groups ?? []))
  for (const pattern of scope.repos ?? []) {
    const separator = pattern.indexOf(':')
    if (separator < 1 || /[*?[{]/.test(pattern)) continue
    for (const group of groupsOf({
      forge: pattern.slice(0, separator),
      path: pattern.slice(separator + 1),
    }))
      owners.add(group)
  }
  return [...owners]
}
