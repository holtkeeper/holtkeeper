import type { Scope } from '@holtkeeper/access'

const hasWildcard = (pattern: string) => /[*?[\]{}]/.test(pattern)

/**
 * How narrowly a scope targets repositories: everything (0) < groups (1) < path globs (2) < exact
 * paths (3). Same ranking as scoped settings.
 */
export function scopeSpecificity(scope: Scope): number {
  if (scope.repos?.some((pattern) => !hasWildcard(pattern))) return 3
  if (scope.repos?.length) return 2
  if (scope.groups?.length) return 1
  return 0
}
