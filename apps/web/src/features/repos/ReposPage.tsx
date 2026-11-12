import type { RepoSummary } from '@holtkeeper/api'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { ChevronRight, FolderGit2, History, Plus } from 'lucide-react'
import { useState } from 'react'

import { useRepos } from '../../api/queries.ts'
import { formatDateTime, formatRelative } from '../../lib/format.ts'
import { cellTones, dotToTagTone, healthLabels, healthOrder, healthTones } from '../../lib/home.ts'
import { repoKey, repoSplat, splitRepoPath } from '../../lib/repo.ts'
import {
  type FleetSortKey,
  type ReposSearch,
  cellStatusWords,
  cellTarget,
  filterRepos,
  fleetCells,
  fleetSortValue,
  fleetStrip,
  freshnessText,
  healthLegend,
  healthSummaryText,
  parseReposSearch,
  reposSort,
  updatesText,
  withReposSort,
  worstFirst,
} from '../../lib/repos.ts'
import { sortRows } from '../../lib/table-sort.ts'
import {
  Button,
  EmptyState,
  ErrorState,
  type FleetColumn,
  FilterButton,
  FleetTable,
  HealthCell,
  Page,
  Placeholder,
  Tag,
} from '../../ui/index.ts'
import { copyLinkItem } from '../shell/copy-link.ts'
import { useScope } from '../shell/scope.ts'
import { useSession } from '../shell/session.ts'
import { AddRepoDialog } from './AddRepoDialog.tsx'
import { RepoAvatar } from './RepoAvatar.tsx'

/** Every repository of the configured groups with its health, as a sortable fleet table. */
export function ReposPage() {
  const { can, canGlobal } = useSession()
  const repos = useRepos()
  const search = useSearch({ from: '/app/repos/' })
  const navigate = useNavigate()
  const setSearch = (next: ReposSearch) =>
    void navigate({ to: '/repos', search: next, replace: true })
  const [adding, setAdding] = useState(false)
  const { view, setView, homeGroups } = useScope()
  const all = repos.data?.repos ?? []
  const sort = reposSort(search)
  const rows = sortRows(worstFirst(filterRepos(all, search)), sort, fleetSortValue)
  const groups = [...new Set(all.flatMap((r) => r.groups))].toSorted()
  const forges = [...new Set(all.map((r) => r.repo.forge))].toSorted()
  const canAdd = canGlobal('settings:write')
  const filtered = Boolean(search.q || search.group || search.health || search.forge)

  const open = (summary: RepoSummary) =>
    void navigate({ to: '/repos/$', params: { _splat: repoSplat(summary.repo) } })

  return (
    <Page
      crumbs={[{ label: 'Repositories' }]}
      title="Repos"
      search={{
        value: search.q ?? '',
        onChange: (q) => setSearch({ ...search, ...(q ? { q } : { q: undefined }) }),
        'aria-label': 'Filter repositories',
        placeholder: 'Filter by path or group',
      }}
      {...(canGlobal('settings:read') && {
        configure: { link: { to: '/settings/$section', params: { section: 'analyzers' } } },
      })}
      more={[
        copyLinkItem,
        ...(can('analyses:read') ? [{ label: 'Show runs', icon: History, href: '/ops/runs' }] : []),
      ]}
      {...(canAdd
        ? { primary: { label: 'Add repository', icon: Plus, onPress: () => setAdding(true) } }
        : {})}
    >
      {repos.isPending ? (
        <Placeholder className="h-64" />
      ) : repos.isError ? (
        <ErrorState error={repos.error} />
      ) : (
        <FleetTable<RepoSummary, FleetSortKey>
          label="Repositories"
          rows={rows}
          rowKey={(summary) => repoKey(summary.repo)}
          columns={repoColumns}
          sort={sort}
          onSort={(next) => setSearch(withReposSort(search, next))}
          scope={{ value: view, onChange: setView, homeGroups }}
          strip={(shown, scope) => fleetStrip(shown, scope === 'mine' ? 'in my teams' : undefined)}
          legend={healthLegend}
          toolbar={
            <>
              <FilterButton
                label="Group"
                options={groups.map((id) => ({ id, label: id }))}
                value={search.group ?? []}
                onChange={(group) =>
                  setSearch({ ...search, group: group.length ? group : undefined })
                }
              />
              <FilterButton
                label="Health"
                options={healthOrder.map((id) => ({ id, label: healthLabels[id] }))}
                value={search.health ?? []}
                onChange={(health) =>
                  setSearch({
                    ...search,
                    health: health.length ? parseReposSearch({ health }).health : undefined,
                  })
                }
              />
              {forges.length > 1 ? (
                <FilterButton
                  label="Forge"
                  options={forges.map((id) => ({ id, label: id }))}
                  value={search.forge ?? []}
                  onChange={(forge) =>
                    setSearch({ ...search, forge: forge.length ? forge : undefined })
                  }
                />
              ) : null}
              {sort ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onPress={() => setSearch(withReposSort(search, null))}
                >
                  Sort: worst first
                </Button>
              ) : null}
            </>
          }
          onOpen={open}
          othersSummary={healthSummaryText}
          caption="· health cells open the matching tab of the repository"
          empty={
            <EmptyState
              icon={<FolderGit2 />}
              title={filtered ? 'No repository matches' : 'No repositories'}
              {...(!filtered && canAdd
                ? {
                    action: (
                      <Button variant="primary" onPress={() => setAdding(true)}>
                        Add repository
                      </Button>
                    ),
                  }
                : {})}
            />
          }
        />
      )}
      {adding ? <AddRepoDialog onClose={() => setAdding(false)} /> : null}
    </Page>
  )
}

/** The repository list's columns, shared with a group's Repositories tab. */
export const repoColumns: readonly FleetColumn<RepoSummary, FleetSortKey>[] = [
  {
    id: 'repo',
    header: 'Repository',
    sortKey: 'repo',
    className: 'min-w-60',
    cell: (summary) => <RepoName summary={summary} />,
  },
  {
    id: 'health',
    header: 'Health',
    sortKey: 'health',
    cell: (summary) => (
      <Tag tone={dotToTagTone(healthTones[summary.health])} dot>
        {healthLabels[summary.health]}
      </Tag>
    ),
  },
  ...fleetCells.map(({ key, label, mono }): FleetColumn<RepoSummary, FleetSortKey> => ({
    id: key,
    header: label,
    sortKey: key,
    cell: (summary) => {
      const cell = summary.cells[key]
      if (!cell) return <span className="text-dim">—</span>
      return (
        <HealthCell
          tone={cellTones[cell.tone]}
          value={cell.value}
          caption={cell.sub || undefined}
          status={cellStatusWords[cell.tone]}
          {...(mono ? { mono } : {})}
          link={cellTarget(summary.repo, key)}
        />
      )
    },
  })),
  {
    id: 'analysed',
    header: 'Last analysed',
    sortKey: 'analysed',
    className: 'whitespace-nowrap',
    cell: (summary) => (
      <div className="flex flex-col gap-0.5 leading-tight">
        {summary.lastAnalysedAt ? (
          <span title={formatDateTime(summary.lastAnalysedAt)}>
            {formatRelative(summary.lastAnalysedAt)}
          </span>
        ) : (
          <span className="text-muted">Never</span>
        )}
        {freshnessText(summary.freshness) ? (
          <span className="text-[11px] text-dim">{freshnessText(summary.freshness)}</span>
        ) : null}
      </div>
    ),
  },
  {
    id: 'updates',
    header: 'Updates',
    cell: (summary) => {
      const updates = updatesText(summary.updates)
      if (!summary.updates) return <span className="text-dim">—</span>
      return (
        <Link
          to="/repos/$"
          params={{ _splat: repoSplat(summary.repo) }}
          search={{ tab: 'settings', section: 'updates' }}
          className="no-underline"
        >
          <Tag tone={dotToTagTone(updates.tone)} dot>
            {updates.text}
          </Tag>
        </Link>
      )
    },
  },
  {
    id: 'open',
    header: <span className="sr-only">Open</span>,
    align: 'right',
    cell: (summary) => (
      <Link
        to="/repos/$"
        params={{ _splat: repoSplat(summary.repo) }}
        aria-label={`Open ${summary.repo.path}`}
        className="inline-flex text-muted hover:text-foreground"
      >
        <ChevronRight className="size-4" />
      </Link>
    ),
  },
]

function RepoName({ summary }: { summary: RepoSummary }) {
  const { repo, groups } = summary
  const { namespace, name } = splitRepoPath(repo.path)
  return (
    <div className="flex items-start gap-2.5">
      <RepoAvatar repo={repo} size="sm" />
      <div className="min-w-0">
        <Link
          to="/repos/$"
          params={{ _splat: repoSplat(repo) }}
          className="mono block truncate hover:underline"
          title={repo.path}
        >
          <span className="text-muted">{namespace}</span>
          <span className="font-medium">{name}</span>
        </Link>
        <div className="mt-0.5 flex flex-wrap items-center gap-1">
          <span className="mono text-[11px] text-dim">{repo.forge}</span>
          {groups.map((group) => (
            <Link
              key={group}
              to="/repos/groups/$groupId"
              params={{ groupId: group }}
              className="no-underline"
            >
              <Tag className="hover:underline">{group}</Tag>
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}
