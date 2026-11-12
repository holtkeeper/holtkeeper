import type { GroupMatch } from '@holtkeeper/api'

import { messageOf } from '../../api/client.ts'
import { usePreferences, useRepos, useSetPreferences } from '../../api/queries.ts'
import { scopeList } from '../../lib/home-scope.ts'
import { healthLabels, healthOrder, healthTones } from '../../lib/home.ts'
import { type TeamRow, homeCombinations, teamRows, toggleHomeGroup } from '../../lib/my-teams.ts'
import { formatGroupMatch, parseGroupMatch, validateGroupMatch } from '../../lib/scope.ts'
import {
  Button,
  Checkbox,
  Dot,
  EmptyState,
  ErrorState,
  Placeholder,
  Table,
  TagInput,
  Td,
  Th,
  notify,
} from '../../ui/index.ts'

const validateCombination = (text: string) =>
  validateGroupMatch(text) ??
  (text.includes('+') ? undefined : 'Join two or more groups with +; tick single groups above')

/**
 * Account › My teams: the groups the *My teams* scope shows, as a table of every group the viewer
 * can see plus group combinations. Defaults to the groups in the viewer's grants.
 */
export function HomeGroups() {
  const preferences = usePreferences()
  const repos = useRepos()
  const save = useSetPreferences()
  const update = (homeGroups: GroupMatch[] | null) =>
    save.mutate(
      { homeGroups },
      { onError: (error) => notify.error('My teams not saved', messageOf(error)) },
    )

  if (preferences.isPending || repos.isPending) return <Placeholder className="h-48" />
  if (preferences.isError) return <ErrorState error={preferences.error} />
  if (repos.isError) return <ErrorState error={repos.error} />

  const home = preferences.data.homeGroups
  const rows = teamRows(repos.data.repos, home)
  const combinations = homeCombinations(home)
  const counts = scopeList(repos.data.repos, 'mine', home).counts

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
        <span className="flex-1">
          {preferences.data.homeGroupsFromGrants
            ? 'From your grants until you change them.'
            : 'Picked by you.'}{' '}
          My teams: <b className="font-medium text-foreground">{counts.mine}</b> of {counts.all}{' '}
          repositories; other teams fold under each list.
        </span>
        {preferences.data.homeGroupsFromGrants ? null : (
          <Button variant="ghost" size="sm" isPending={save.isPending} onPress={() => update(null)}>
            Use my grants
          </Button>
        )}
      </div>
      {rows.length ? (
        <Table label="Groups you can add to My teams">
          <thead>
            <tr>
              <Th className="w-28">In My teams</Th>
              <Th>Group</Th>
              <Th align="right">Repositories</Th>
              <Th>Health</Th>
              <Th>Forge</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.group}>
                <Td>
                  <Checkbox
                    label={<span className="sr-only">{`${row.group} in My teams`}</span>}
                    isSelected={row.inMyTeams}
                    isDisabled={save.isPending}
                    onChange={(on) => update(toggleHomeGroup(home, row.group, on))}
                  />
                </Td>
                <Td className="font-medium">{row.group}</Td>
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
        <EmptyState title="No groups yet" description="Repositories you can see are in no group." />
      )}
      <TagInput
        label="Group combinations"
        values={combinations.map(formatGroupMatch)}
        onChange={(values) =>
          update([
            ...home.filter((entry) => typeof entry === 'string'),
            ...values.map(parseGroupMatch),
          ])
        }
        validate={validateCombination}
        suggestions={rows.map((row) => row.group)}
        placeholder="Add a combination, e.g. web + payments"
        description="Groups joined with + match repositories in all of them."
      />
    </div>
  )
}

function TeamHealth({ health }: { health: TeamRow['health'] }) {
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
