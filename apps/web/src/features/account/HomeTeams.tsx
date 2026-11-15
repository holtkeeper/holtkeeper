import { messageOf } from '../../api/client.ts'
import {
  useMe,
  usePreferences,
  useRepos,
  useSetPreferences,
  useTeamTitles,
} from '../../api/queries.ts'
import { scopeList } from '../../lib/home-scope.ts'
import { healthLabels, healthOrder, healthTones } from '../../lib/home.ts'
import { type MyTeamRow, myTeamRows, toggleHomeTeam } from '../../lib/my-teams.ts'
import {
  Button,
  Checkbox,
  Dot,
  EmptyState,
  ErrorState,
  TeamName,
  notify,
  Placeholder,
  Table,
  Td,
  Th,
} from '../../ui/index.ts'

/**
 * Account › My teams: the teams the *My teams* scope shows, as a table of every team the viewer
 * can see with a tick each. Defaults to the teams the viewer is a member of or whose grants name.
 */
export function HomeTeams() {
  const preferences = usePreferences()
  const repos = useRepos()
  const save = useSetPreferences()
  const titleOf = useTeamTitles()
  const known = Object.keys(useMe().data?.teamTitles ?? {})
  const update = (homeTeams: string[] | null) =>
    save.mutate(
      { homeTeams },
      { onError: (error) => notify.error('My teams not saved', messageOf(error)) },
    )

  if (preferences.isPending || repos.isPending) return <Placeholder className="h-48" />
  if (preferences.isError) return <ErrorState error={preferences.error} />
  if (repos.isError) return <ErrorState error={repos.error} />

  const home = preferences.data.homeTeams
  const rows = myTeamRows(repos.data.repos, home, titleOf, known)
  const counts = scopeList(repos.data.repos, 'mine', home).counts

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
        <span className="flex-1">
          {preferences.data.homeTeamsFromMembership
            ? 'From your memberships and grants until you change them.'
            : 'Picked by you.'}{' '}
          My teams: <b className="font-medium text-foreground">{counts.mine}</b> of {counts.all}{' '}
          repositories; other teams fold under each list.
        </span>
        {preferences.data.homeTeamsFromMembership ? null : (
          <Button variant="ghost" size="sm" isPending={save.isPending} onPress={() => update(null)}>
            Use my memberships
          </Button>
        )}
      </div>
      {rows.length ? (
        <Table label="Teams you can add to My teams">
          <thead>
            <tr>
              <Th className="w-28">In My teams</Th>
              <Th>Team</Th>
              <Th align="right">Repositories</Th>
              <Th>Health</Th>
              <Th>Forge</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.team}>
                <Td>
                  <Checkbox
                    label={<span className="sr-only">{`${titleOf(row.team)} in My teams`}</span>}
                    isSelected={row.inMyTeams}
                    isDisabled={save.isPending}
                    onChange={(on) => update(toggleHomeTeam(home, row.team, on))}
                  />
                </Td>
                <Td className="font-medium">
                  <TeamName team={row.team} />
                </Td>
                <Td align="right" className="tabular">
                  {row.repos}
                </Td>
                <Td>
                  <TeamHealth health={row.health} />
                </Td>
                <Td className="mono text-xs text-muted">{row.forges.join(' · ')}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <EmptyState
          title="No teams yet"
          description="No team owns a repository you can see. Teams are set up under Repos › Teams."
        />
      )}
    </div>
  )
}

function TeamHealth({ health }: { health: MyTeamRow['health'] }) {
  const parts = healthOrder.filter((status) => health[status] > 0)
  if (!parts.length) return <span className="text-dim">—</span>
  return (
    <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs whitespace-nowrap">
      {parts.map((status) => (
        <span key={status} className="inline-flex items-center gap-1.5">
          <Dot tone={healthTones[status]} />
          <span className="tabular">{health[status]}</span>
          <span className="text-muted">{healthLabels[status].toLowerCase()}</span>
        </span>
      ))}
    </span>
  )
}
