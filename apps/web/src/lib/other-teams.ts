import { plural } from './format.ts'

/**
 * Text of the folded other-teams row: "40 repositories of 3 other teams", or
 * "40 repositories of other teams" when the teams are not known.
 */
export function otherTeamsText(
  count: number,
  teams: number,
  noun: { one: string; many?: string } = { one: 'repository', many: 'repositories' },
): string {
  const items = plural(count, noun.one, noun.many)
  return teams > 0 ? `${items} of ${plural(teams, 'other team')}` : `${items} of other teams`
}
