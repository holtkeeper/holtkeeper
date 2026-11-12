import type { Action, Grant, Scope } from '@holtkeeper/api'

import { formatGroupMatch, normalizeScope } from './scope.ts'

/** The four presets People hands out, narrowest first. */
export const rolePresetIds = ['viewer', 'developer', 'maintainer', 'admin'] as const

export type RolePresetId = (typeof rolePresetIds)[number]

/** A preset, or `custom` for grants matching none, or `none` without grants. */
export type RoleId = RolePresetId | 'custom' | 'none'

interface RolePreset {
  label: string
  summary: string
  description: string
  /** `*` only for Admin, which always applies to every repository. */
  actions: readonly (Action | '*')[]
}

const viewer: readonly Action[] = [
  'repos:read',
  'analyses:read',
  'audits:read',
  'releases:read',
  'knowledge:read',
  'settings:read',
]
const developer: readonly Action[] = [
  ...viewer,
  'analyses:run',
  'audits:run',
  'tasks:run',
  'knowledge:write',
]
const maintainer: readonly Action[] = [...developer, 'releases:run', 'settings:write']

/** What each preset allows; a preset applies to one scope, except Admin, which is org-wide. */
export const rolePresets: Readonly<Record<RolePresetId, RolePreset>> = {
  viewer: {
    label: 'Viewer',
    summary: 'Read only',
    description: 'Reads health, libraries, releases, knowledge and settings in its scope.',
    actions: viewer,
  },
  developer: {
    label: 'Developer',
    summary: 'Run analyzers, start agent tasks',
    description: 'Viewer, plus runs analyzers and audits, starts agent tasks and writes notes.',
    actions: developer,
  },
  maintainer: {
    label: 'Maintainer',
    summary: 'Run release steps, edit settings in scope',
    description: 'Developer, plus runs release steps and edits settings in its scope.',
    actions: maintainer,
  },
  admin: {
    label: 'Admin',
    summary: 'Org-wide, including people and credentials',
    description: 'Everything on every repository: people, credentials, AI budget and integrations.',
    actions: ['*'],
  },
}

/** Words for every `RoleId`. */
export const roleNames: Readonly<Record<RoleId, string>> = {
  viewer: 'Viewer',
  developer: 'Developer',
  maintainer: 'Maintainer',
  admin: 'Admin',
  custom: 'Custom',
  none: 'No access',
}

const sameActions = (a: readonly (Action | '*')[], b: readonly (Action | '*')[]) =>
  a.length === b.length && new Set(a).size === b.length && b.every((action) => a.includes(action))

function mergeScopes(scopes: readonly Scope[]): Scope {
  if (scopes.some((scope) => scope.all)) return { all: true }
  return normalizeScope({
    groups: scopes.flatMap((scope) => scope.groups ?? []),
    repos: scopes.flatMap((scope) => scope.repos ?? []),
  })
}

/** How a set of grants reads in People: a preset with the scope it applies to, or not. */
type RoleMatch = { role: RolePresetId; scope: Scope } | { role: 'custom' | 'none' }

/**
 * The preset `grants` are exactly: Admin when any grant is `*` on every repository (the others add
 * nothing, as `roleOf` of `@holtkeeper/access` counts admins), else every grant allows the same
 * actions as one preset and the scope is the union of the grants' scopes. Anything else is
 * `custom`, which People shows as it is and never rewrites unless someone picks a preset.
 */
export function roleOf(grants: readonly Grant[]): RoleMatch {
  if (grants.length === 0) return { role: 'none' }
  if (grants.some((grant) => grant.scope.all && grant.actions.includes('*')))
    return { role: 'admin', scope: { all: true } }
  const preset = rolePresetIds.find(
    (id) =>
      id !== 'admin' &&
      grants.every((grant) => sameActions(grant.actions, rolePresets[id].actions)),
  )
  if (!preset) return { role: 'custom' }
  return { role: preset, scope: mergeScopes(grants.map((grant) => grant.scope)) }
}

const scopeKey = (scope: Scope) => {
  const normal = normalizeScope(scope)
  return JSON.stringify([
    normal.all === true,
    (normal.groups ?? []).map(formatGroupMatch).toSorted(),
    (normal.repos ?? []).toSorted(),
  ])
}

/**
 * Whether two sets of grants give the same access as People reads it: the same preset on the same
 * scope, however the grants are split or their actions ordered; grants matching no preset only
 * when they are identical.
 */
export function sameAccess(a: readonly Grant[], b: readonly Grant[]): boolean {
  const left = roleOf(a)
  const right = roleOf(b)
  if (left.role !== right.role) return false
  if ('scope' in left && 'scope' in right) return scopeKey(left.scope) === scopeKey(right.scope)
  return JSON.stringify(a) === JSON.stringify(b)
}

/** The grants of a preset on `scope`; Admin ignores the scope and covers every repository. */
export function grantsForRole(role: RolePresetId, scope: Scope): Grant[] {
  if (role === 'admin') return [{ scope: { all: true }, actions: ['*'] }]
  return [{ scope: normalizeScope(scope), actions: [...rolePresets[role].actions] }]
}

/** One row of the "What they can do" table. */
interface RoleAbility {
  area: string
  label: string
  /** Any of these allows the ability. */
  actions: readonly Action[]
}

/** The abilities People compares roles by, grouped by area in display order. */
const roleAbilities: readonly RoleAbility[] = [
  {
    area: 'Repositories',
    label: 'See repositories, health and analysis records',
    actions: ['repos:read'],
  },
  {
    area: 'Repositories',
    label: 'Run analyzers and audits',
    actions: ['analyses:run', 'audits:run'],
  },
  { area: 'Agents', label: 'Start agent tasks that change code', actions: ['tasks:run'] },
  { area: 'Releases', label: 'See release plans and timelines', actions: ['releases:read'] },
  { area: 'Releases', label: 'Run release steps', actions: ['releases:run'] },
  { area: 'Knowledge', label: 'Read knowledge', actions: ['knowledge:read'] },
  { area: 'Knowledge', label: 'Write notes, approve learnings', actions: ['knowledge:write'] },
  { area: 'Settings', label: 'Read settings and the effective config', actions: ['settings:read'] },
  { area: 'Settings', label: 'Change settings in scope', actions: ['settings:write'] },
  { area: 'AI', label: 'See AI spend', actions: ['ai:read', 'ai:admin'] },
  { area: 'AI', label: 'Change the AI budget and provider', actions: ['ai:admin'] },
  { area: 'People', label: 'Invite and edit people', actions: ['users:invite', 'users:write'] },
  {
    area: 'Credentials',
    label: 'Add, rotate or delete credentials',
    actions: ['credentials:write'],
  },
  { area: 'Audit log', label: 'Read the whole audit log', actions: ['audit:read'] },
]

const allows = (grants: readonly Grant[], ability: RoleAbility) =>
  grants.some(
    (grant) =>
      grant.actions.includes('*') ||
      ability.actions.some((action) => grant.actions.includes(action)),
  )

/** Whether an ability is allowed now, gained or lost by a change, or allowed by neither. */
export type AbilityState = 'allowed' | 'gains' | 'loses' | 'no'

/** Each ability with how `next` grants change it from `current` ones. */
export function abilityChanges(
  current: readonly Grant[],
  next: readonly Grant[],
): { ability: RoleAbility; state: AbilityState }[] {
  return roleAbilities.map((ability) => {
    const before = allows(current, ability)
    const after = allows(next, ability)
    const state: AbilityState = after ? (before ? 'allowed' : 'gains') : before ? 'loses' : 'no'
    return { ability, state }
  })
}
