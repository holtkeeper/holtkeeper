import {
  type Action,
  type Grant,
  type Principal,
  type RepoTarget,
  type Scope,
  type Target,
  type TeamPatterns,
  actions,
} from './model.ts'
import { isExactPattern, literalDepth, patternMatches, patternWithin } from './paths.ts'

/** Team definitions scope checks may expand, by key. */
export type TeamPatternsByKey = Readonly<Record<string, TeamPatterns>>

/** Actions a grant of the key action also allows. */
const implied: Partial<Record<Action, Action>> = { 'catalog:read': 'analyses:read' }

function allows(grant: Grant, action: Action): boolean {
  if (grant.actions.includes('*') || grant.actions.includes(action)) return true
  const parent = implied[action]
  return parent !== undefined && grant.actions.includes(parent)
}

/** Whether `scope` covers the repository. */
export function scopeCoversRepo(scope: Scope, repo: RepoTarget): boolean {
  if (scope.all) return true
  if ((scope.teams ?? []).some((team) => repo.teams.includes(team))) return true
  return (scope.repos ?? []).some((pattern) => patternMatches(pattern, repo.forge, repo.path))
}

/**
 * Whether every repository `pattern` matches is owned by the team. A team with exclusions holds
 * only exact paths it owns, since a glob could reach into an excluded folder.
 */
function patternInTeam(pattern: string, team: TeamPatterns): boolean {
  if (!team.exclude?.length) return team.owns.some((owned) => patternWithin(pattern, owned))
  if (!isExactPattern(pattern)) return false
  const separator = pattern.indexOf(':')
  if (separator < 1) return false
  const forge = pattern.slice(0, separator)
  const path = pattern.slice(separator + 1)
  return (
    team.owns.some((owned) => patternMatches(owned, forge, path)) &&
    !team.exclude.some((excluded) => patternMatches(excluded, forge, path))
  )
}

function patternInScope(pattern: string, outer: Scope, teams: TeamPatternsByKey): boolean {
  if ((outer.repos ?? []).some((candidate) => patternWithin(pattern, candidate))) return true
  return (outer.teams ?? []).some((key) => {
    const team = teams[key]
    return team !== undefined && patternInTeam(pattern, team)
  })
}

function teamInScope(key: string, outer: Scope, teams: TeamPatternsByKey): boolean {
  if (outer.teams?.includes(key)) return true
  const team = teams[key]
  return (
    team !== undefined &&
    team.owns.length > 0 &&
    team.owns.every((pattern) => patternInScope(pattern, outer, teams))
  )
}

/**
 * Whether everything `inner` covers is also covered by `outer`. Path patterns are compared
 * segment by segment (`patternWithin`); teams are expanded to their patterns when `teams` knows
 * them, otherwise a team is only within a scope naming it. Never answers too generously.
 */
export function scopeWithin(inner: Scope, outer: Scope, teams: TeamPatternsByKey = {}): boolean {
  if (outer.all) return true
  if (inner.all) return false
  return (
    (inner.teams ?? []).every((key) => teamInScope(key, outer, teams)) &&
    (inner.repos ?? []).every((pattern) => patternInScope(pattern, outer, teams))
  )
}

/** The specificity of one path pattern: exact paths 3, globs 2 plus a tenth per pinned folder. */
const patternSpecificity = (pattern: string): number =>
  isExactPattern(pattern) ? 3 : 2 + Math.min(literalDepth(pattern), 9) / 10

/**
 * How narrowly a scope targets repositories, for picking the entry that applies when several cover
 * one: everything (0) < teams (1) < path globs (2, plus 0.1 per literal leading folder, so
 * `acme/round/**` outranks `acme/**`) < exact paths (3). Entries are OR-ed, so a scope ranks by
 * its broadest entry; an empty scope ranks 0.
 */
export function scopeSpecificity(scope: Scope): number {
  if (scope.all) return 0
  const ranks = [
    ...(scope.teams ?? []).map(() => 1),
    ...(scope.repos ?? []).map(patternSpecificity),
  ]
  return ranks.length ? Math.min(...ranks) : 0
}

function grantCovers(grant: Grant, target: Target, teams: TeamPatternsByKey): boolean {
  if (target.kind === 'repo') return scopeCoversRepo(grant.scope, target.repo)
  if (target.kind === 'scope') return scopeWithin(target.scope, grant.scope, teams)
  return grant.scope.all === true
}

/** Whether the principal may perform `action` on `target`. */
export const can = (principal: Principal, action: Action, target: Target): boolean =>
  principal.grants.some(
    (grant) => allows(grant, action) && grantCovers(grant, target, principal.teamDefs ?? {}),
  )

/**
 * Whether `grants` give nothing beyond what `parent` already has. Used to let people hand out
 * access — invites, API tokens — only within their own: an admin of `acme/**` can invite admins
 * of `acme/*\/game-frontend`, but not of everything.
 */
export function grantsWithin(
  grants: readonly Grant[],
  parent: readonly Grant[],
  teams: TeamPatternsByKey = {},
): boolean {
  return grants.every((grant) => {
    const granted = grant.actions.includes('*') ? actions : grant.actions.filter((a) => a !== '*')
    return granted.every((action) =>
      parent.some(
        (candidate) =>
          allows(candidate, action) && scopeWithin(grant.scope, candidate.scope, teams),
      ),
    )
  })
}

/** Whether the principal may hand out `grants` to someone else. */
export const canDelegate = (principal: Principal, grants: readonly Grant[]): boolean =>
  grants.every((grant) => can(principal, 'users:invite', { kind: 'scope', scope: grant.scope })) &&
  grantsWithin(grants, principal.grants, principal.teamDefs ?? {})
