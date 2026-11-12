import type { Grant } from './model.ts'

/**
 * The one coarse reading of a set of grants every surface shows: `admin` for `*` on every
 * repository, `viewer` when every action only reads, `none` without grants, `custom` otherwise.
 */
export type Role = 'admin' | 'viewer' | 'custom' | 'none'

/** The `Role` `grants` read as. Scopes count only for `admin`; group names never do. */
export function roleOf(grants: readonly Grant[]): Role {
  if (grants.length === 0) return 'none'
  if (grants.some((grant) => grant.scope.all === true && grant.actions.includes('*')))
    return 'admin'
  const reads = grants.every((grant) =>
    grant.actions.every((action) => action !== '*' && action.endsWith(':read')),
  )
  return reads ? 'viewer' : 'custom'
}
