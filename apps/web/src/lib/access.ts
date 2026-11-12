import type { Action, CrossTeamLevel, Grant, Principal, Role } from '@holtkeeper/api'

import { roleNames, roleOf } from './roles.ts'
import { type SettingsSectionId, settingsSectionIds } from './settings-sections.ts'

/** Every action a grant can name, in the order the UI lists them. Mirrors `Action` exactly. */
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
] as const satisfies readonly Action[]

type MissingAction = Exclude<Action, (typeof actions)[number]>
const exhaustive: MissingAction extends never ? true : never = true
void exhaustive

/**
 * Whether any of the principal's grants allows `action`, ignoring scopes. Only decides what the
 * UI shows; the server still checks every request against the exact scope.
 */
export function can(principal: Principal | null | undefined, action: Action): boolean {
  if (!principal) return false
  return principal.grants.some(
    (grant) => grant.actions.includes('*') || grant.actions.includes(action),
  )
}

/**
 * Whether a grant over every repository (`scope.all`) allows `action`: what the server asks for on
 * global objects such as the config, storage and the database. Only decides what the UI shows.
 */
export function canGlobal(principal: Principal | null | undefined, action: Action): boolean {
  if (!principal) return false
  return principal.grants.some(
    (grant) =>
      grant.scope.all === true && (grant.actions.includes('*') || grant.actions.includes(action)),
  )
}

/**
 * Whether a grant covering all of group `group` allows `action`: one over every repository or one
 * naming the group on its own, as the server checks writes scoped `{ groups: [group] }`. Only
 * decides what the UI shows.
 */
export function canInGroup(
  principal: Principal | null | undefined,
  action: Action,
  group: string,
): boolean {
  if (!principal) return false
  return principal.grants.some(
    (grant) =>
      (grant.scope.all === true || (grant.scope.groups ?? []).includes(group)) &&
      (grant.actions.includes('*') || grant.actions.includes(action)),
  )
}

/** Whether `can` allows reading AI spend somewhere: `ai:read` or `ai:admin`. */
export const canReadSpend = (allows: (action: Action) => boolean): boolean =>
  allows('ai:read') || allows('ai:admin')

/**
 * Whether the principal reaches some team's catalog (Dependencies, Public API, Stack): a
 * `catalog:read` or `analyses:read` grant, or any read grant while `crossTeam` is not `off`.
 * Mirrors the server's catalog check; only decides what the UI shows.
 */
export function canCatalog(
  principal: Principal | null | undefined,
  crossTeam: CrossTeamLevel,
): boolean {
  if (!principal) return false
  const reads: readonly Action[] =
    crossTeam === 'off'
      ? ['catalog:read', 'analyses:read']
      : ['catalog:read', 'analyses:read', 'repos:read']
  return reads.some((action) => can(principal, action))
}

/** Short human summary of grants, e.g. `everything: all actions` or `2 grants, 7 actions`. */
export function summarizeGrants(grants: readonly Grant[]): string {
  if (grants.length === 0) return 'no access'
  const all = grants.some((grant) => grant.actions.includes('*'))
  const distinct = new Set(grants.flatMap((grant) => grant.actions.filter((a) => a !== '*')))
  const what = all ? 'all actions' : `${distinct.size} action${distinct.size === 1 ? '' : 's'}`
  return grants.length === 1 ? what : `${grants.length} grants, ${what}`
}

/** What each action lets a person do, as a short phrase after "can" or "can't". */
export const actionLabels: Readonly<Record<Action, string>> = {
  'repos:read': 'read repositories',
  'audits:read': 'read security audits',
  'audits:run': 'run security audits and fixes',
  'analyses:read': 'read analyses',
  'analyses:run': 'run analyzers',
  'catalog:read': "read other teams' catalog",
  'releases:read': 'read releases',
  'releases:run': 'run release steps',
  'tasks:run': 'approve agent tasks that change code',
  'settings:read': 'read settings',
  'settings:write': 'change settings',
  'credentials:read': 'read credentials',
  'credentials:write': 'change credentials',
  'knowledge:read': 'read knowledge',
  'knowledge:write': 'change knowledge',
  'ai:read': 'read AI spend',
  'ai:admin': 'manage AI spend',
  'users:read': 'see people',
  'users:invite': 'invite people',
  'users:write': 'change people and their access',
  'audit:read': 'read the whole audit log',
}

/**
 * Words for the coarse `Role` the server sends before sign-in (the setup link page), taken from
 * the preset names People uses.
 */
export const roleLabels: Readonly<Record<Role, string>> = {
  admin: roleNames.admin,
  viewer: roleNames.viewer,
  custom: roleNames.custom,
  none: roleNames.none,
}

/**
 * The role People shows for a set of grants (a preset, `Custom` or `No access`, from `roleOf` of
 * `lib/roles.ts`), so Account and the Forbidden card name it the same way.
 */
export const roleLabel = (grants: readonly Grant[]): string => roleNames[roleOf(grants).role]

const settingsSectionAccess: Readonly<
  Record<SettingsSectionId, (principal: Principal) => boolean>
> = {
  people: (principal) => can(principal, 'users:read') || can(principal, 'settings:read'),
  ai: (principal) => can(principal, 'settings:read') || can(principal, 'credentials:read'),
  integrations: (principal) =>
    can(principal, 'credentials:read') || can(principal, 'settings:read'),
  analyzers: (principal) => can(principal, 'settings:read'),
  policies: (principal) => can(principal, 'settings:read'),
  system: (principal) => canGlobal(principal, 'settings:read'),
  audit: (principal) => can(principal, 'repos:read') || canGlobal(principal, 'audit:read'),
}

/** The permission a Forbidden card names for a Settings section the principal cannot open. */
export const settingsSectionRequires: Readonly<Record<SettingsSectionId, Action>> = {
  people: 'users:read',
  ai: 'settings:read',
  integrations: 'settings:read',
  analyzers: 'settings:read',
  policies: 'settings:read',
  system: 'settings:read',
  audit: 'repos:read',
}

/**
 * The Settings sections the principal can open, in display order, mirroring what the server lets
 * them read: People needs `users:read` (the people list) or `settings:read` (its Reach settings), Audit log `repos:read` (their repositories' events) or a
 * global `audit:read`, System a global `settings:read`, AI and Integrations `settings:read` or
 * `credentials:read`, Analyzers and Policies `settings:read` on some scope. Only decides what the
 * UI shows.
 */
export const visibleSettingsSections = (
  principal: Principal | null | undefined,
): SettingsSectionId[] =>
  principal ? settingsSectionIds.filter((id) => settingsSectionAccess[id](principal)) : []
