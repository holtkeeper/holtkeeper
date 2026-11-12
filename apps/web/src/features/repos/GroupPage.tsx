import type { RepoSummary } from '@holtkeeper/api'
import { useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { FolderGit2 } from 'lucide-react'
import { useState } from 'react'

import { useGroupListing, useGroups, useRepos } from '../../api/queries.ts'
import { formatRelative } from '../../lib/format.ts'
import { repoKey, repoSplat } from '../../lib/repo.ts'
import {
  type FleetSortKey,
  countHealth,
  fleetSortValue,
  groupMembership,
  healthLegend,
  pickGroupTab,
  worstFirst,
} from '../../lib/repos.ts'
import { parseStackTab } from '../../lib/stack.ts'
import { type SortState, sortRows } from '../../lib/table-sort.ts'
import {
  EmptyState,
  ErrorState,
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

/**
 * One group: its repositories as a fleet table, its stack, its Guide, the settings made for it and
 * its membership (patterns, forge listing and what they resolve to).
 */
export function GroupPage() {
  const { can, canGlobal } = useSession()
  const { groupId } = useParams({ from: '/app/repos/groups/$groupId' })
  const search = useSearch({ from: '/app/repos/groups/$groupId' })
  const navigate = useNavigate({ from: '/repos/groups/$groupId' })
  const repos = useRepos()
  const config = useGroups(canGlobal('settings:read'))
  const definition = config.data?.entries.find((entry) => entry.id === groupId)
  const listing = useGroupListing(groupId, can('settings:read'))
  const all = repos.data?.repos ?? []
  const members = all.filter((r) => r.groups.includes(groupId))
  const allGroups = [...new Set(all.flatMap((r) => r.groups))].toSorted()
  const { tabs, tab } = pickGroupTab(can, search.tab, canGlobal)
  const forge = definition?.data.forge ?? listing.data?.forge ?? members[0]?.repo.forge
  const counts = countHealth(members)
  const membership =
    definition && listing.data && forge
      ? groupMembership(forge, listing.data.matched ?? [], definition.data)
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
            label: 'on the forge',
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

  return (
    <Page
      crumbs={[{ label: 'Groups', link: { to: '/repos/groups' } }, { label: groupId }]}
      title={groupId}
      description={forge ? <span className="mono">{forge}</span> : undefined}
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
          <GroupRepositories members={members} />
        )
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
          <GroupMembership key={definition.version ?? 0} entry={definition} members={members} />
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

function GroupRepositories({ members }: { members: readonly RepoSummary[] }) {
  const navigate = useNavigate()
  const [sort, setSort] = useState<SortState<FleetSortKey>>(null)
  const rows = sortRows(worstFirst(members), sort, fleetSortValue)
  return (
    <FleetTable<RepoSummary, FleetSortKey>
      label="Group repositories"
      rows={rows}
      rowKey={(summary) => repoKey(summary.repo)}
      columns={repoColumns}
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
  )
}
