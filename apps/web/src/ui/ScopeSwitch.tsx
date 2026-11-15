import { ListBox, Popover } from '@heroui/react'
import { Link } from '@tanstack/react-router'
import { ChevronDown, Users } from 'lucide-react'

import { useTeamNames, useTeamTitles, usePreferences } from '../api/queries.ts'
import {
  type TeamCount,
  type ScopeCounts,
  type ScopeView,
  teamView,
  viewTeam,
} from '../lib/home-scope.ts'
import { type TeamTitleOf, byTeamTitle } from '../lib/team-titles.ts'
import { Button, LinkButton } from './Button.tsx'
import { Count } from './Count.tsx'
import { EmptyState } from './Feedback.tsx'
import { Segmented } from './Toggle.tsx'

const labels = { mine: 'My teams', all: 'All I can see' } as const

const teamsLink = { to: '/account/$section', params: { section: 'teams' } } as const

function TeamPicker({
  value,
  onChange,
  teams,
}: {
  value: ScopeView
  onChange: (view: ScopeView) => void
  teams: readonly (Pick<TeamCount, 'team'> & { count?: number })[]
}) {
  const chosen = viewTeam(value)
  const titleOf = useTeamTitles()
  return (
    <Popover>
      <Button variant="secondary" className="min-w-32 max-w-56 justify-between">
        <span className="truncate">
          Team: {chosen === undefined ? 'Any' : <b className="font-medium">{titleOf(chosen)}</b>}
        </span>
        <ChevronDown aria-hidden className="size-3.5 shrink-0" />
      </Button>
      <Popover.Content placement="bottom start" className="min-w-56">
        <Popover.Dialog aria-label="Team" className="flex flex-col gap-1 p-1">
          {teams.length ? (
            <ListBox
              aria-label="Team"
              selectionMode="single"
              selectedKeys={new Set(chosen === undefined ? [] : [chosen])}
              onSelectionChange={(keys) => {
                const [next] = keys === 'all' ? [] : [...keys].map(String)
                if (next !== undefined) onChange(teamView(next))
              }}
              className="max-h-72 overflow-auto"
            >
              {teams.map(({ team, count }) => (
                <ListBox.Item key={team} id={team} textValue={`${titleOf(team)} ${team}`}>
                  <span className="min-w-0 flex-1 truncate">
                    {titleOf(team)}
                    {titleOf(team) === team ? null : (
                      <span className="mono ms-1.5 text-[11px] text-dim">{team}</span>
                    )}
                  </span>
                  {count === undefined ? null : <Count>{count}</Count>}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          ) : (
            <p className="px-2 py-1.5 text-sm text-muted">No teams to pick from.</p>
          )}
          {chosen === undefined ? null : (
            <Button variant="ghost" size="sm" onPress={() => onChange('mine')}>
              Clear
            </Button>
          )}
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  )
}

/**
 * The teams the scope picker lists: every team the viewer can see (the teams `resolveScopeView`
 * accepts) by title, each with its count from `counts` (0 when it has none there), plus the
 * chosen team while repositories load.
 */
function pickerTeams(
  names: readonly string[],
  chosen: string | undefined,
  counts: ScopeCounts | undefined,
  titleOf: TeamTitleOf,
): { team: string; count?: number }[] {
  const listed = (
    chosen === undefined || names.includes(chosen) ? names : [...names, chosen]
  ).toSorted(byTeamTitle(titleOf))
  const byTeam = new Map(counts?.teams.map(({ team, count }) => [team, count]))
  return listed.map((team) => (counts ? { team, count: byTeam.get(team) ?? 0 } : { team }))
}

/**
 * The quiet "Choose your teams" link to Account › My teams, shown once preferences say the viewer
 * has no home teams. Toolbars put it last so nothing shifts when it appears.
 */
export function ChooseTeamsLink() {
  const preferences = usePreferences()
  if (!preferences.isSuccess || preferences.data.homeTeams.length) return null
  return (
    <Link {...teamsLink} className="text-sm text-muted underline-offset-2 hover:underline">
      Choose your teams
    </Link>
  )
}

/**
 * The scope switch of list pages: *My teams* and *All I can see* with their item counts, then a
 * "Team: Any" picker listing every team the viewer can see (with counts when `counts` has them).
 * Picking a team selects neither segment. With `teamsLink` (the default) it ends with
 * `ChooseTeamsLink`; toolbars that place that link themselves pass `false`.
 */
export function ScopeSwitch({
  value,
  onChange,
  counts,
  teamsLink: withTeamsLink = true,
}: {
  value: ScopeView
  onChange: (view: ScopeView) => void
  counts?: ScopeCounts
  teamsLink?: boolean
}) {
  const names = useTeamNames()
  const titleOf = useTeamTitles()
  const teams = pickerTeams(names, viewTeam(value), counts, titleOf)
  const options = (['mine', 'all'] as const).map((id) => ({
    id: id as ScopeView,
    label: (
      <span className="inline-flex items-center gap-1.5">
        {labels[id]}
        {counts ? <span className="tabular text-muted">{counts[id]}</span> : null}
      </span>
    ),
  }))
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Segmented aria-label="Scope" options={options} value={value} onChange={onChange} />
      <TeamPicker value={value} onChange={onChange} teams={teams} />
      {withTeamsLink ? <ChooseTeamsLink /> : null}
    </span>
  )
}

/**
 * The empty state of a list under *My teams* when the viewer has no home teams yet, with a
 * link to Account › My teams. Renders nothing until preferences load or when home teams exist.
 */
export function NoTeamsState() {
  const preferences = usePreferences()
  if (!preferences.isSuccess || preferences.data.homeTeams.length) return null
  return (
    <EmptyState
      icon={<Users />}
      title="No teams chosen yet"
      description="My teams shows the repositories your teams own. Choose them, or switch to All I can see."
      action={
        <LinkButton {...teamsLink} size="sm">
          Choose your teams
        </LinkButton>
      }
    />
  )
}
