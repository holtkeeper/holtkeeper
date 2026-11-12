import { type ConfigEntryView, type RepoSummary, parentGroup } from '@holtkeeper/api'
import { useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { FolderGit2, MoveRight } from 'lucide-react'
import { useState } from 'react'

import { useGroupListing, useGroups, useGroupTitles, useRepos } from '../../api/queries.ts'
import { formatRelative, plural } from '../../lib/format.ts'
import { repoKey, repoSplat } from '../../lib/repo.ts'
import {
  type FleetSortKey,
  countHealth,
  fleetSortValue,
  groupMembership,
  groupRows,
  healthLegend,
  pickGroupTab,
  siblingOverlaps,
  worstFirst,
} from '../../lib/repos.ts'
import { parseStackTab } from '../../lib/stack.ts'
import { type SortState, sortRows } from '../../lib/table-sort.ts'
import {
  Button,
  type Crumb,
  EmptyState,
  ErrorState,
  type FleetColumn,
  FleetTable,
  Notice,
  Page,
  Placeholder,
  SegmentedTabs,
  Strip,
  type StripCell,
} from '../../ui/index.ts'
import { RunJobButton } from '../jobs/RunJobDialog.tsx'
import { ResolvedSettings } from '../settings/ResolvedSettings.tsx'
import { useSession } from '../shell/session.ts'
import { StackView } from '../stack/StackPage.tsx'
import { GroupMembership } from './GroupListing.tsx'
import { repoColumns } from './ReposPage.tsx'
import { ScopeGuide } from './ScopeGuide.tsx'
import { MoveToSubgroupDialog, SubgroupsTab } from './Subgroups.tsx'

/**
 * One group: its repositories as a fleet table, its subgroups (for a root group), its stack, its
 * Guide, the settings made for it and its membership (patterns, forge listing and what they
 * resolve to). A subgroup's crumbs lead through its parent.
 */
export function GroupPage() {
  const { can, canGlobal } = useSession()
  const { groupId } = useParams({ from: '/app/repos/groups/$groupId' })
  const search = useSearch({ from: '/app/repos/groups/$groupId' })
  const navigate = useNavigate({ from: '/repos/groups/$groupId' })
  const repos = useRepos()
  const titleOf = useGroupTitles()
  const config = useGroups(canGlobal('settings:read'))
  const definition = config.data?.entries.find((entry) => entry.id === groupId)
  const listing = useGroupListing(groupId, can('settings:read'))
  const all = repos.data?.repos ?? []
  const members = all.filter((r) => r.groups.includes(groupId))
  const allGroups = [...new Set(all.flatMap((r) => r.groups))].toSorted()
  const { tabs, tab } = pickGroupTab(can, search.tab, canGlobal, groupId)
  const parent = parentGroup(groupId)
  const root = parent ?? groupId
  const tree = groupRows(all, config.data?.entries ?? []).find((row) => row.id === root)
  const subgroupIds = (config.data?.entries ?? [])
    .filter((entry) => parentGroup(entry.id) === root)
    .map((entry) => entry.id)
    .toSorted()
  const overlaps = parent === undefined ? siblingOverlaps(members, groupId) : new Map()
  const forge = definition?.data.forge ?? listing.data?.forge ?? members[0]?.repo.forge
  const title = definition?.data.title ?? titleOf(groupId)
  const subtitle = [title !== groupId ? groupId : undefined, forge].filter(Boolean).join(' · ')
  const counts = countHealth(members)
  const membership =
    definition && listing.data && forge
      ? groupMembership(
          forge,
          listing.data.matched ?? [],
          definition.data,
          definition.data,
          parent === undefined,
        )
      : undefined
  const strip: StripCell[] = [
    ...(definition
      ? [
          {
            value: definition.data.include.length,
            label: 'include',
            caption: `· ${definition.data.exclude.length} exclude patterns`,
          },
        ]
      : []),
    ...(membership
      ? [
          {
            prefix: 'Resolves to',
            value: membership.members + membership.excluded,
            label: parent === undefined ? 'on the forge' : 'in parent',
          },
        ]
      : []),
    {
      value: members.length,
      label: members.length === 1 ? 'member' : 'members',
      ...(membership ? { caption: `· ${membership.excluded} excluded` } : {}),
    },
    { value: counts.failing, label: 'failing', tone: 'danger' },
    { value: counts.warnings, label: 'with warnings', tone: 'warning' },
    { value: counts.healthy, label: 'healthy', tone: 'success' },
    ...(listing.data?.listedAt
      ? [
          {
            prefix: listing.data.attempts[0]?.error ? 'Listing failed · listed' : 'Listed',
            value: formatRelative(listing.data.listedAt),
            label: '',
            ...(listing.data.nextAt
              ? { caption: `· next ${formatRelative(listing.data.nextAt)}` }
              : {}),
            tone: listing.data.attempts[0]?.error ? ('danger' as const) : ('success' as const),
            end: true,
          },
        ]
      : []),
  ]

  const crumbs: Crumb[] = [
    { label: 'Groups', link: { to: '/repos/groups' } },
    ...(parent === undefined
      ? []
      : [
          {
            label: titleOf(parent),
            link: { to: '/repos/groups/$groupId', params: { groupId: parent } },
          } satisfies Crumb,
        ]),
    { label: title },
  ]

  return (
    <Page
      crumbs={crumbs}
      title={title}
      description={subtitle ? <span className="mono">{subtitle}</span> : undefined}
      tabs={false}
      actions={
        <RunJobButton group={groupId} label="Run job for group" size="sm" variant="secondary" />
      }
    >
      <div className="-mx-4 -mt-4 flex flex-col">
        <div className="border-b border-line px-3.5 py-2.5">
          <SegmentedTabs
            aria-label="Group sections"
            items={tabs.map(({ id, label }) => ({
              id,
              label:
                id === 'repos' && members.length ? (
                  <>
                    {label} <span className="tabular text-dim">{members.length}</span>
                  </>
                ) : id === 'subgroups' && tree?.subgroups.length ? (
                  <>
                    {label} <span className="tabular text-dim">{tree.subgroups.length}</span>
                  </>
                ) : (
                  label
                ),
            }))}
            selected={tab}
            onSelect={(next) =>
              void navigate({ search: next === 'repos' ? {} : { tab: next }, replace: true })
            }
          />
        </div>
        <Strip cells={strip} label="Group summary" />
      </div>
      {tab === 'repos' ? (
        repos.isPending ? (
          <Placeholder className="h-48" />
        ) : repos.isError ? (
          <ErrorState error={repos.error} />
        ) : (
          <>
            {overlaps.size ? (
              <Notice
                tone="warning"
                title={`${plural(overlaps.size, 'repository', 'repositories')} in two subgroups or more`}
              >
                <span className="block">
                  Their subgroup settings tie and the newest entry wins.
                </span>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {[...overlaps.entries()].slice(0, OVERLAPS_SHOWN).map(([key, subs]) => (
                    <li key={key}>
                      <span className="mono">{key.slice(key.indexOf(':') + 1)}</span>{' '}
                      <span className="text-muted">{subs.map(titleOf).join(', ')}</span>
                    </li>
                  ))}
                  {overlaps.size > OVERLAPS_SHOWN ? (
                    <li className="text-muted">+{overlaps.size - OVERLAPS_SHOWN} more</li>
                  ) : null}
                </ul>
              </Notice>
            ) : null}
            <GroupRepositories
              members={members}
              {...(canGlobal('settings:write') && config.data && subgroupIds.length
                ? {
                    move: {
                      entries: config.data.entries,
                      subgroups: subgroupIds,
                      leaving: (summary: RepoSummary) =>
                        parent === undefined
                          ? summary.groups.filter((group) => subgroupIds.includes(group))
                          : [groupId],
                    },
                  }
                : {})}
            />
          </>
        )
      ) : null}
      {tab === 'subgroups' ? (
        <SubgroupsTab row={tree} definition={definition} members={members} />
      ) : null}
      {tab === 'stack' ? (
        <StackView
          group={groupId}
          tab={parseStackTab(search.view)}
          onTab={(view) =>
            void navigate({
              search: { tab: 'stack', ...(view === 'runtimes' ? {} : { view }) },
              replace: true,
            })
          }
        />
      ) : null}
      {tab === 'knowledge' ? <ScopeGuide space={{ kind: 'group', group: groupId }} /> : null}
      {tab === 'settings' ? <GroupSettingsTab group={groupId} groups={allGroups} /> : null}
      {tab === 'membership' ? (
        config.isPending && canGlobal('settings:read') ? (
          <Placeholder className="h-48" />
        ) : config.isError ? (
          <ErrorState error={config.error} />
        ) : definition ? (
          <GroupMembership
            key={`${definition.id}:${definition.version ?? 0}`}
            entry={definition}
            members={members}
          />
        ) : (
          <Notice tone="warning" title="Not in the config">
            {canGlobal('settings:read')
              ? `No group ${groupId} is configured; entries naming it match nothing.`
              : 'Reading the group patterns needs settings:read over every repository.'}
          </Notice>
        )
      ) : null}
    </Page>
  )
}

/** The Settings tab of a group: the settings resolver for the group. */
function GroupSettingsTab({ group, groups }: { group: string; groups: readonly string[] }) {
  return <ResolvedSettings focus={{ kind: 'group', group }} groups={groups} />
}

const OVERLAPS_SHOWN = 5

function GroupRepositories({
  members,
  move,
}: {
  members: readonly RepoSummary[]
  /** Offers "Move to subgroup" on each member. */
  move?: {
    entries: readonly ConfigEntryView<'group'>[]
    /** Subgroups of the root group. */
    subgroups: readonly string[]
    /** The subgroups a member leaves when it moves. */
    leaving: (summary: RepoSummary) => string[]
  }
}) {
  const navigate = useNavigate()
  const [sort, setSort] = useState<SortState<FleetSortKey>>(null)
  const [moving, setMoving] = useState<RepoSummary>()
  const rows = sortRows(worstFirst(members), sort, fleetSortValue)
  const columns: readonly FleetColumn<RepoSummary, FleetSortKey>[] = move
    ? [
        ...repoColumns,
        {
          id: 'move',
          header: <span className="sr-only">Move to subgroup</span>,
          align: 'right',
          cell: (summary) =>
            move.subgroups.some((id) => !move.leaving(summary).includes(id)) ? (
              <Button
                variant="ghost"
                size="sm"
                isIconOnly
                aria-label={`Move ${summary.repo.path} to subgroup`}
                onPress={() => setMoving(summary)}
              >
                <MoveRight className="size-3.5" />
              </Button>
            ) : null,
        },
      ]
    : repoColumns
  const leaving = moving && move ? move.leaving(moving) : []
  return (
    <>
      <FleetTable<RepoSummary, FleetSortKey>
        label="Group repositories"
        rows={rows}
        rowKey={(summary) => repoKey(summary.repo)}
        columns={columns}
        sort={sort}
        onSort={setSort}
        legend={healthLegend}
        onOpen={(summary) =>
          void navigate({ to: '/repos/$', params: { _splat: repoSplat(summary.repo) } })
        }
        empty={
          <EmptyState
            icon={<FolderGit2 />}
            title="No repositories you can see"
            description="Members show up once the forge listing finds them or an exact path names them."
          />
        }
      />
      {moving && move ? (
        <MoveToSubgroupDialog
          repo={moving}
          from={leaving}
          targets={move.subgroups.filter((id) => !leaving.includes(id))}
          entries={move.entries}
          onClose={() => setMoving(undefined)}
        />
      ) : null}
    </>
  )
}
