import { groupLineage } from './groups.ts'
import {
  type Action,
  type Grant,
  type GroupMatch,
  type Principal,
  type RepoTarget,
  type Scope,
  type Target,
  actions,
} from './model.ts'

function splitPattern(pattern: string): { forge?: string; glob: string } {
  const separator = pattern.indexOf(':')
  return separator > 0
    ? { forge: pattern.slice(0, separator), glob: pattern.slice(separator + 1) }
    : { glob: pattern }
}

/** Actions a grant of the key action also allows. */
const implied: Partial<Record<Action, Action>> = { 'catalog:read': 'analyses:read' }

function allows(grant: Grant, action: Action): boolean {
  if (grant.actions.includes('*') || grant.actions.includes(action)) return true
  const parent = implied[action]
  return parent !== undefined && grant.actions.includes(parent)
}

const allOf = (entry: GroupMatch) => (typeof entry === 'string' ? [entry] : entry)

const closureOf = (entry: GroupMatch) => new Set(allOf(entry).flatMap(groupLineage))

/** Whether a repository in `memberOf` matches one of `entries` (see `GroupMatch`). */
export const groupsMatch = (entries: readonly GroupMatch[], memberOf: readonly string[]): boolean =>
  entries.some((entry) => allOf(entry).every((group) => memberOf.includes(group)))

/** Every group name `entries` mention, for validating references. */
export const groupNames = (entries: readonly GroupMatch[]): string[] => [
  ...new Set(entries.flatMap(allOf)),
]

/** Whether `scope` covers the repository. */
export function scopeCoversRepo(scope: Scope, repo: RepoTarget): boolean {
  if (scope.all) return true
  if (groupsMatch(scope.groups ?? [], repo.groups)) return true
  return (scope.repos ?? []).some((pattern) => {
    const { forge, glob } = splitPattern(pattern)
    return (forge === undefined || forge === repo.forge) && new Bun.Glob(glob).match(repo.path)
  })
}

const hasWildcard = (glob: string) => /[*?[\]{}]/.test(glob)

/**
 * Whether every path `inner` can match is also matched by `outer`. Exact for literal paths and
 * `prefix/**` patterns; anything else counts as not covered, so the check never grants too much.
 */
function patternWithin(inner: string, outer: string): boolean {
  const a = splitPattern(inner)
  const b = splitPattern(outer)
  if (b.forge !== undefined && a.forge !== b.forge) return false
  if (a.glob === b.glob || b.glob === '**') return true
  if (!hasWildcard(a.glob)) return new Bun.Glob(b.glob).match(a.glob)
  if (b.glob.endsWith('/**')) {
    const prefix = b.glob.slice(0, -2)
    return !hasWildcard(prefix) && a.glob.startsWith(prefix)
  }
  return false
}

/**
 * Whether everything `inner` covers is also covered by `outer`. Conservative, see `patternWithin`.
 * A subgroup is within its parent (`shapes.round` within `shapes`), never the other way round.
 */
export function scopeWithin(inner: Scope, outer: Scope): boolean {
  if (outer.all) return true
  if (inner.all) return false
  const groupsOk = (inner.groups ?? []).every((entry) => {
    const closure = closureOf(entry)
    return (outer.groups ?? []).some((candidate) =>
      allOf(candidate).every((group) => closure.has(group)),
    )
  })
  const reposOk = (inner.repos ?? []).every((pattern) =>
    (outer.repos ?? []).some((candidate) => patternWithin(pattern, candidate)),
  )
  return groupsOk && reposOk
}

/**
 * How narrowly a scope targets repositories, for picking the entry that applies when several cover
 * one: everything (0) < groups (1) < subgroups and group intersections (between 1 and 2, higher
 * the more groups must match at once, counting a subgroup's ancestors) < path globs (2) < exact
 * paths (3). A subgroup (1.5) always ranks above its parent (1). Group entries are OR-ed, so a
 * scope ranks by its broadest entry: `['shapes', 'shapes.round']` ranks like `['shapes']`.
 */
export function scopeSpecificity(scope: Scope): number {
  if (scope.repos?.some((pattern) => !hasWildcard(splitPattern(pattern).glob))) return 3
  if (scope.repos?.length) return 2
  const sizes = (scope.groups ?? []).map((entry) => closureOf(entry).size)
  const widest = sizes.length ? Math.min(...sizes) : 0
  return widest ? 2 - 1 / widest : 0
}

function grantCovers(grant: Grant, target: Target): boolean {
  if (target.kind === 'repo') return scopeCoversRepo(grant.scope, target.repo)
  if (target.kind === 'scope') return scopeWithin(target.scope, grant.scope)
  return grant.scope.all === true
}

/** Whether the principal may perform `action` on `target`. */
export const can = (principal: Principal, action: Action, target: Target): boolean =>
  principal.grants.some((grant) => allows(grant, action) && grantCovers(grant, target))

/**
 * Whether `grants` give nothing beyond what `parent` already has. Used to let people hand out
 * access — invites, API tokens — only within their own: an admin of `games/**` can invite admins
 * of `games/app/**`, but not of everything.
 */
export function grantsWithin(grants: readonly Grant[], parent: readonly Grant[]): boolean {
  return grants.every((grant) => {
    const granted = grant.actions.includes('*') ? actions : grant.actions.filter((a) => a !== '*')
    return granted.every((action) =>
      parent.some(
        (candidate) => allows(candidate, action) && scopeWithin(grant.scope, candidate.scope),
      ),
    )
  })
}

/** Whether the principal may hand out `grants` to someone else. */
export const canDelegate = (principal: Principal, grants: readonly Grant[]): boolean =>
  grants.every((grant) => can(principal, 'users:invite', { kind: 'scope', scope: grant.scope })) &&
  grantsWithin(grants, principal.grants)
