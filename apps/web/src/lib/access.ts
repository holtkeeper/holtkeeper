import type { Action, Grant, Principal } from '@holtkeeper/api'

/** Every action a grant can name, in the order the UI lists them. Mirrors `Action` exactly. */
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

/** Short human summary of grants, e.g. `everything: all actions` or `2 grants, 7 actions`. */
export function summarizeGrants(grants: readonly Grant[]): string {
  if (grants.length === 0) return 'no access'
  const all = grants.some((grant) => grant.actions.includes('*'))
  const distinct = new Set(grants.flatMap((grant) => grant.actions.filter((a) => a !== '*')))
  const what = all ? 'all actions' : `${distinct.size} action${distinct.size === 1 ? '' : 's'}`
  return grants.length === 1 ? what : `${grants.length} grants, ${what}`
}
