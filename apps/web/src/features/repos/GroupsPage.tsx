import { Link, useNavigate } from '@tanstack/react-router'
import { ChevronRight, FolderGit2, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'

import { useGroups, useGroupTitles, useRepos } from '../../api/queries.ts'
import { plural } from '../../lib/format.ts'
import { type GroupTitleOf, groupMatchesQuery } from '../../lib/group-titles.ts'
import { type GroupRow, groupHealthText, groupRows } from '../../lib/repos.ts'
import { type SortState, sortRows } from '../../lib/table-sort.ts'
import {
  EmptyState,
  ErrorState,
  type FleetColumn,
  FleetTable,
  Page,
  Placeholder,
  Tag,
} from '../../ui/index.ts'
import { useScope } from '../shell/scope.ts'
import { useSession } from '../shell/session.ts'
import { AddRepoDialog } from './AddRepoDialog.tsx'

type GroupSortKey = 'group' | 'members' | 'failing'

const sortValueOf = (titleOf: GroupTitleOf) => (row: GroupRow, key: GroupSortKey) =>
  key === 'group'
    ? titleOf(row.id).toLowerCase()
    : key === 'members'
      ? row.members.length
      : -row.counts.failing

/**
 * Every group the viewer can see: configured ones (with global `settings:read`) and those its
 * repositories are in, with their patterns and their members' health.
 */
export function GroupsPage() {
  const { canGlobal } = useSession()
  const repos = useRepos()
  const config = useGroups(canGlobal('settings:read'))
  const navigate = useNavigate()
  const { view, setView, homeGroups } = useScope()
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortState<GroupSortKey>>(null)
  const [adding, setAdding] = useState(false)
  const titleOf = useGroupTitles()
  const columns = useMemo(() => columnsFor(titleOf), [titleOf])
  const needle = query.trim().toLowerCase()
  const rows = sortRows(
    groupRows(repos.data?.repos ?? [], config.data?.entries ?? []).filter(
      (row) =>
        !needle ||
        groupMatchesQuery(row.id, titleOf, needle) ||
        row.include?.some((pattern) => pattern.toLowerCase().includes(needle)),
    ),
    sort,
    sortValueOf(titleOf),
  )
  const canAdd = canGlobal('settings:write')

  return (
    <Page
      crumbs={[{ label: 'Groups' }]}
      title="Repos"
      search={{
        value: query,
        onChange: setQuery,
        'aria-label': 'Filter groups',
        placeholder: 'Filter by name, key or pattern',
      }}
      {...(canAdd
        ? { primary: { label: 'Add repository', icon: Plus, onPress: () => setAdding(true) } }
        : {})}
    >
      {repos.isPending ? (
        <Placeholder className="h-48" />
      ) : repos.isError ? (
        <ErrorState error={repos.error} />
      ) : (
        <FleetTable<GroupRow, GroupSortKey>
          label="Groups"
          rows={rows}
          rowKey={(row) => row.id}
          columns={columns}
          sort={sort}
          onSort={setSort}
          scope={{ value: view, onChange: setView, homeGroups }}
          noun={{ one: 'group' }}
          strip={(shown) => {
            const members = new Set(
              shown.flatMap((row) => row.members.map((m) => `${m.repo.forge}:${m.repo.path}`)),
            )
            return [
              { value: shown.length, label: shown.length === 1 ? 'group' : 'groups' },
              { value: members.size, label: members.size === 1 ? 'repository' : 'repositories' },
              {
                value: shown.filter((row) => row.counts.failing > 0).length,
                label: 'with failing repositories',
                tone: 'danger',
              },
            ]
          }}
          onOpen={(row) =>
            void navigate({ to: '/repos/groups/$groupId', params: { groupId: row.id } })
          }
          empty={
            <EmptyState
              icon={<FolderGit2 />}
              title={needle ? 'No group matches' : 'No groups yet'}
              description="A group appears once a repository is added to it."
            />
          }
        />
      )}
      {adding ? <AddRepoDialog onClose={() => setAdding(false)} /> : null}
    </Page>
  )
}

const columnsFor = (titleOf: GroupTitleOf): readonly FleetColumn<GroupRow, GroupSortKey>[] => [
  {
    id: 'group',
    header: 'Group',
    sortKey: 'group',
    cell: (row) => (
      <div className="flex flex-col gap-0.5">
        <Link
          to="/repos/groups/$groupId"
          params={{ groupId: row.id }}
          className="font-medium hover:underline"
        >
          {titleOf(row.id)}
        </Link>
        {titleOf(row.id) !== row.id || row.forge ? (
          <span className="mono text-[11px] text-dim">
            {[titleOf(row.id) !== row.id ? row.id : undefined, row.forge]
              .filter(Boolean)
              .join(' · ')}
          </span>
        ) : null}
      </div>
    ),
  },
  {
    id: 'patterns',
    header: 'Patterns',
    cell: (row) =>
      row.include ? (
        <div className="flex flex-wrap gap-1">
          {row.include.slice(0, 3).map((pattern) => (
            <Tag key={pattern} mono>
              {pattern}
            </Tag>
          ))}
          {row.include.length > 3 ? (
            <span className="text-xs text-muted">+{row.include.length - 3}</span>
          ) : null}
          {row.exclude?.length ? (
            <span className="text-xs text-muted">· {plural(row.exclude.length, 'exclude')}</span>
          ) : null}
        </div>
      ) : (
        <span className="text-dim">—</span>
      ),
  },
  {
    id: 'members',
    header: 'Repositories',
    sortKey: 'members',
    align: 'right',
    cell: (row) => <span className="tabular">{row.members.length}</span>,
  },
  {
    id: 'health',
    header: 'Health',
    sortKey: 'failing',
    cell: (row) => {
      const parts = groupHealthText(row.counts)
      return parts.length ? (
        <span className="text-xs text-muted">{parts.join(' · ')}</span>
      ) : (
        <span className="text-dim">—</span>
      )
    },
  },
  {
    id: 'open',
    header: <span className="sr-only">Open</span>,
    align: 'right',
    cell: (row) => (
      <Link
        to="/repos/groups/$groupId"
        params={{ groupId: row.id }}
        aria-label={`Open group ${titleOf(row.id)}`}
        className="inline-flex text-muted hover:text-foreground"
      >
        <ChevronRight className="size-4" />
      </Link>
    ),
  },
]
