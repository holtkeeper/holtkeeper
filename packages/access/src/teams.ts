import type { Action, Grant, Principal } from './model.ts'
import { patternMatches } from './paths.ts'

/**
 * Format of a team key: lowercase letters, digits and dashes, starting with a letter. Keys are
 * flat: folders replace subgroups.
 */
export const TEAM_KEY_PATTERN = /^[a-z][a-z0-9-]*$/

/** What a member may do in their team: maintainers manage it, members work in it. */
export type TeamRole = 'maintainer' | 'member'

/** One person in a team, by principal id or e-mail (compared case-insensitively). */
export interface TeamMember {
  id: string
  role: TeamRole
}

/**
 * A team as access reads it: path patterns it owns (minus `exclude`), patterns it only consumes,
 * and its members. Patterns are those of `@holtkeeper/access/paths`.
 */
export interface TeamDefinition {
  owns: readonly string[]
  exclude?: readonly string[]
  consumes?: readonly string[]
  members?: readonly TeamMember[]
}

/** Whether the team owns the repository at `path` on `forge`. */
export const teamOwns = (team: TeamDefinition, forge: string, path: string): boolean =>
  team.owns.some((pattern) => patternMatches(pattern, forge, path)) &&
  !(team.exclude ?? []).some((pattern) => patternMatches(pattern, forge, path))

/** Keys of every team owning the repository, in the order of `teams`. */
export const teamsOwning = (
  teams: Readonly<Record<string, TeamDefinition>>,
  forge: string,
  path: string,
): string[] =>
  Object.entries(teams)
    .filter(([, team]) => teamOwns(team, forge, path))
    .map(([key]) => key)

/** Actions a team member gets on the team's repositories. Maintainers get `*`. */
export const MEMBER_ACTIONS: readonly Action[] = [
  'repos:read',
  'audits:read',
  'audits:run',
  'analyses:read',
  'analyses:run',
  'releases:read',
  'releases:run',
  'tasks:run',
  'settings:read',
  'knowledge:read',
  'knowledge:write',
  'ai:read',
  'users:read',
]

/** Actions every member of a team gets on the repositories the team consumes. */
export const CONSUMER_ACTIONS: readonly Action[] = [
  'repos:read',
  'analyses:read',
  'releases:read',
  'knowledge:read',
]

const sameId = (member: TeamMember, principal: Pick<Principal, 'id' | 'email'>) => {
  const id = member.id.toLowerCase()
  return id === principal.id.toLowerCase() || id === principal.email?.toLowerCase()
}

/** The role the principal holds in the team, or `undefined` when not a member. */
export function teamRoleOf(
  team: TeamDefinition,
  principal: Pick<Principal, 'id' | 'email'>,
): TeamRole | undefined {
  const roles = (team.members ?? []).filter((member) => sameId(member, principal))
  if (roles.some((member) => member.role === 'maintainer')) return 'maintainer'
  return roles.length ? 'member' : undefined
}

/**
 * The grants team membership gives the principal: `*` on `{ teams: [key] }` for maintainers,
 * `MEMBER_ACTIONS` there for members, and `CONSUMER_ACTIONS` on the team's `consumes` patterns
 * for both. Add them to the principal's own grants; they never cover anything outside the teams'
 * patterns.
 */
export function teamGrants(
  teams: Readonly<Record<string, TeamDefinition>>,
  principal: Pick<Principal, 'id' | 'email'>,
): Grant[] {
  const grants: Grant[] = []
  for (const [key, team] of Object.entries(teams)) {
    const role = teamRoleOf(team, principal)
    if (!role) continue
    grants.push({
      scope: { teams: [key] },
      actions: role === 'maintainer' ? ['*'] : [...MEMBER_ACTIONS],
    })
    if (team.consumes?.length) {
      grants.push({ scope: { repos: [...team.consumes] }, actions: [...CONSUMER_ACTIONS] })
    }
  }
  return grants
}

/** Keys of the teams the principal belongs to, in the order of `teams`. */
export const teamsOfPrincipal = (
  teams: Readonly<Record<string, TeamDefinition>>,
  principal: Pick<Principal, 'id' | 'email'>,
): string[] =>
  Object.entries(teams)
    .filter(([, team]) => teamRoleOf(team, principal) !== undefined)
    .map(([key]) => key)
