import type { RepoSummary } from '@holtkeeper/api'
import { useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { FolderGit2, Pencil } from 'lucide-react'
import { useState } from 'react'

import { useRepos, useTeams, useTeamTitles } from '../../api/queries.ts'
import { repoSplat, repoKey } from '../../lib/repo.ts'
import {
  type FleetSortKey,
  countHealth,
  fleetSortValue,
  healthLegend,
  pickTeamTab,
  teamConsumes,
  teamEditLevel,
  teamOwns,
  worstFirst,
} from '../../lib/repos.ts'
import { parseStackTab } from '../../lib/stack.ts'
import { type SortState, sortRows } from '../../lib/table-sort.ts'
import {
  Button,
  EmptyState,
  ErrorState,
  FleetTable,
  Page,
  Placeholder,
  SegmentedTabs,
  Strip,
  type StripCell,
  Tag,
} from '../../ui/index.ts'
import { RunJobButton } from '../jobs/RunJobDialog.tsx'
import { ScopedRules } from '../knowledge/ScopedKnowledge.tsx'
import { ResolvedSettings } from '../settings/ResolvedSettings.tsx'
import { useSession } from '../shell/session.ts'
import { StackView } from '../stack/StackPage.tsx'
import { repoColumns } from './ReposPage.tsx'
import { TeamDialog } from './TeamDialog.tsx'

/**
 * One team: the repositories it owns as a fleet table (those it consumes listed after), its stack,
 * the rules scoped to it and the settings resolved for it, with its patterns and members in the summary strip.
 * Global `settings:write` and the team's maintainers get Edit.
 */
export function TeamPage() {
  const { can, principal } = useSession()
  const { teamId } = useParams({ from: '/app/repos/teams/$teamId' })
  const search = useSearch({ from: '/app/repos/teams/$teamId' })
  const navigate = useNavigate({ from: '/repos/teams/$teamId' })
  const repos = useRepos()
  const titleOf = useTeamTitles()
  const config = useTeams(can('settings:read'))
  const [editing, setEditing] = useState(false)
  const entry = config.data?.entries.find((candidate) => candidate.id === teamId)
  const all = repos.data?.repos ?? []
  const owned = entry
    ? all.filter((r) => teamOwns(entry.data, r.repo))
    : all.filter((r) => r.teams.includes(teamId))
  const consumed = entry
    ? all.filter((r) => teamConsumes(entry.data, r.repo) && !owned.includes(r))
    : []
  const { tabs, tab } = pickTeamTab(can, search.tab)
  const level = teamEditLevel(principal.grants, teamId)
  const title = entry?.data.title ?? titleOf(teamId)
  const counts = countHealth(owned)
  const maintainers = (entry?.data.members ?? []).filter((m) => m.role === 'maintainer')
  const strip: StripCell[] = [
    { value: owned.length, label: owned.length === 1 ? 'repository' : 'repositories' },
    ...(consumed.length ? [{ value: consumed.length, label: 'consumed' }] : []),
    { value: counts.failing, label: 'failing', tone: 'danger' },
    { value: counts.warnings, label: 'with warnings', tone: 'warning' },
    { value: counts.healthy, label: 'healthy', tone: 'success' },
    ...(entry
      ? [
          {
            value: entry.data.members.length,
            label: entry.data.members.length === 1 ? 'member' : 'members',
            caption: maintainers.length ? `· ${maintainers.length} maintaining` : '',
            end: true,
          },
        ]
      : []),
  ]

  return (
    <Page
      crumbs={[{ label: 'Teams', link: { to: '/repos/teams' } }, { label: title }]}
      title={title}
      description={
        <span className="flex flex-wrap items-center gap-1">
          {title !== teamId ? <span className="mono">{teamId}</span> : null}
          {(entry?.data.owns ?? []).map((pattern) => (
            <Tag key={pattern} mono>
              {pattern}
            </Tag>
          ))}
          {(entry?.data.exclude ?? []).map((pattern) => (
            <Tag key={pattern} mono>
              not {pattern}
            </Tag>
          ))}
        </span>
      }
      tabs={false}
      actions={
        <span className="flex items-center gap-2">
          {entry && level !== 'none' ? (
            <Button variant="secondary" size="sm" onPress={() => setEditing(true)}>
              <Pencil className="size-3.5" />
              Edit
            </Button>
          ) : null}
          <RunJobButton team={teamId} label="Run job for team" size="sm" variant="secondary" />
        </span>
      }
    >
      <div className="-mx-4 -mt-4 flex flex-col">
        <div className="border-b border-line px-3.5 py-2.5">
          <SegmentedTabs
            aria-label="Team sections"
            items={tabs.map(({ id, label }) => ({
              id,
              label:
                id === 'repos' && owned.length ? (
                  <>
                    {label} <span className="tabular text-dim">{owned.length}</span>
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
        <Strip cells={strip} label="Team summary" />
      </div>
      {tab === 'repos' ? (
        repos.isPending ? (
          <Placeholder className="h-48" />
        ) : repos.isError ? (
          <ErrorState error={repos.error} />
        ) : (
          <>
            <TeamRepositories label="Owned repositories" rows={owned} />
            {consumed.length ? (
              <TeamRepositories label="Consumed repositories" rows={consumed} />
            ) : null}
          </>
        )
      ) : null}
      {tab === 'stack' ? (
        <StackView
          team={teamId}
          tab={parseStackTab(search.view)}
          onTab={(view) =>
            void navigate({
              search: { tab: 'stack', ...(view === 'runtimes' ? {} : { view }) },
              replace: true,
            })
          }
        />
      ) : null}
      {tab === 'knowledge' ? (
        <ScopedRules query={{ team: teamId }} title="Rules of this team" />
      ) : null}
      {tab === 'settings' ? <ResolvedSettings focus={{ kind: 'team', team: teamId }} /> : null}
      {editing && entry && level !== 'none' ? (
        <TeamDialog entry={entry} level={level} repos={all} onClose={() => setEditing(false)} />
      ) : null}
    </Page>
  )
}

function TeamRepositories({ label, rows }: { label: string; rows: readonly RepoSummary[] }) {
  const navigate = useNavigate()
  const [sort, setSort] = useState<SortState<FleetSortKey>>(null)
  return (
    <FleetTable<RepoSummary, FleetSortKey>
      label={label}
      rows={sortRows(worstFirst(rows), sort, fleetSortValue)}
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
          description="Repositories show up once the team's patterns match fleet repositories."
        />
      }
    />
  )
}
