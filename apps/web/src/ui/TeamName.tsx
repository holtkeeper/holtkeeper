import { useTeamTitles } from '../api/queries.ts'

/** A team as people read it: its display title, or its key when it has none. */
export function TeamName({ team }: { team: string }) {
  const titleOf = useTeamTitles()
  return titleOf(team)
}
