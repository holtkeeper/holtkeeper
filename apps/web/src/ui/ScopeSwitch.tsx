import { ListBox, Popover } from '@heroui/react'
import { Link } from '@tanstack/react-router'
import { ChevronDown, Users } from 'lucide-react'

import { useGroupNames, useGroupTitles, usePreferences } from '../api/queries.ts'
import { type GroupTitleOf, byGroupTitle } from '../lib/group-titles.ts'
import {
  type GroupCount,
  type ScopeCounts,
  type ScopeView,
  groupView,
  viewGroup,
} from '../lib/home-scope.ts'
import { Button, LinkButton } from './Button.tsx'
import { Count } from './Count.tsx'
import { EmptyState } from './Feedback.tsx'
import { Segmented } from './Toggle.tsx'

const labels = { mine: 'My teams', all: 'All I can see' } as const

const teamsLink = { to: '/account/$section', params: { section: 'teams' } } as const

function GroupPicker({
  value,
  onChange,
  groups,
}: {
  value: ScopeView
  onChange: (view: ScopeView) => void
  groups: readonly (Pick<GroupCount, 'group'> & { count?: number })[]
}) {
  const chosen = viewGroup(value)
  const titleOf = useGroupTitles()
  return (
    <Popover>
      <Button variant="secondary" className="min-w-32 max-w-56 justify-between">
        <span className="truncate">
          Group: {chosen === undefined ? 'Any' : <b className="font-medium">{titleOf(chosen)}</b>}
        </span>
        <ChevronDown aria-hidden className="size-3.5 shrink-0" />
      </Button>
      <Popover.Content placement="bottom start" className="min-w-56">
        <Popover.Dialog aria-label="Group" className="flex flex-col gap-1 p-1">
          {groups.length ? (
            <ListBox
              aria-label="Group"
              selectionMode="single"
              selectedKeys={new Set(chosen === undefined ? [] : [chosen])}
              onSelectionChange={(keys) => {
                const [next] = keys === 'all' ? [] : [...keys].map(String)
                if (next !== undefined) onChange(groupView(next))
              }}
              className="max-h-72 overflow-auto"
            >
              {groups.map(({ group, count }) => (
                <ListBox.Item key={group} id={group} textValue={`${titleOf(group)} ${group}`}>
                  <span className="min-w-0 flex-1 truncate">
                    {titleOf(group)}
                    {titleOf(group) === group ? null : (
                      <span className="mono ms-1.5 text-[11px] text-dim">{group}</span>
                    )}
                  </span>
                  {count === undefined ? null : <Count>{count}</Count>}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          ) : (
            <p className="px-2 py-1.5 text-sm text-muted">No groups to pick from.</p>
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
 * The groups the scope picker lists: every group the viewer can see (the groups `resolveScopeView`
 * accepts) ordered by title, each with its count from `counts` (0 when it has none there), plus
 * the chosen group while repositories load.
 */
function pickerGroups(
  names: readonly string[],
  chosen: string | undefined,
  counts: ScopeCounts | undefined,
  titleOf: GroupTitleOf,
): { group: string; count?: number }[] {
  const listed = (
    chosen === undefined || names.includes(chosen) ? names : [...names, chosen]
  ).toSorted(byGroupTitle(titleOf))
  const byGroup = new Map(counts?.groups.map(({ group, count }) => [group, count]))
  return listed.map((group) => (counts ? { group, count: byGroup.get(group) ?? 0 } : { group }))
}

/**
 * The quiet "Choose your teams" link to Account › My teams, shown once preferences say the viewer
 * has no home groups. Toolbars put it last so nothing shifts when it appears.
 */
export function ChooseTeamsLink() {
  const preferences = usePreferences()
  if (!preferences.isSuccess || preferences.data.homeGroups.length) return null
  return (
    <Link {...teamsLink} className="text-sm text-muted underline-offset-2 hover:underline">
      Choose your teams
    </Link>
  )
}

/**
 * The scope switch of list pages: *My teams* and *All I can see* with their item counts, then a
 * "Group: Any" picker listing every group the viewer can see (with counts when `counts` has
 * them). Picking a group selects neither segment. With `teamsLink` (the default) it ends with
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
  const names = useGroupNames()
  const titleOf = useGroupTitles()
  const groups = pickerGroups(names, viewGroup(value), counts, titleOf)
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
      <GroupPicker value={value} onChange={onChange} groups={groups} />
      {withTeamsLink ? <ChooseTeamsLink /> : null}
    </span>
  )
}

/**
 * The empty state of a list under *My teams* when the viewer has no home groups yet, with a
 * link to Account › My teams. Renders nothing until preferences load or when home groups exist.
 */
export function NoTeamsState() {
  const preferences = usePreferences()
  if (!preferences.isSuccess || preferences.data.homeGroups.length) return null
  return (
    <EmptyState
      icon={<Users />}
      title="No teams chosen yet"
      description="My teams shows the groups you work in. Choose them, or switch to All I can see."
      action={
        <LinkButton {...teamsLink} size="sm">
          Choose your teams
        </LinkButton>
      }
    />
  )
}
