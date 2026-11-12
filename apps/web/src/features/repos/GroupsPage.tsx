import { Link, useNavigate } from '@tanstack/react-router'
import { ChevronDown, ChevronRight, FolderGit2, Plus } from 'lucide-react'
import { useState } from 'react'

import { useGroups, useGroupTitles, useRepos } from '../../api/queries.ts'
import { plural } from '../../lib/format.ts'
import { type GroupTitleOf, groupMatchesQuery } from '../../lib/group-titles.ts'
import { type GroupRow, groupHealthText, groupRows, groupTreeRows } from '../../lib/repos.ts'
import { type SortState, sortRows } from '../../lib/table-sort.ts'
import {
  EmptyState,
  ErrorState,
  type FleetColumn,
  FleetTable,
  Page,
  Placeholder,
  Tag,
  Button,
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
 * Every group the viewer can see as a tree: configured ones (with global `settings:read`) and
 * those its repositories are in, with their patterns and their members' health. Subgroups fold
 * under their parent; a filter opens the parents of the subgroups it matches.
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
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const titleOf = useGroupTitles()
  const needle = query.trim().toLowerCase()
  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  const columns = columnsFor(titleOf, needle ? undefined : { open, toggle })
  const rows = groupTreeRows(
    groupRows(repos.data?.repos ?? [], config.data?.entries ?? []),
    open,
    needle
      ? (row) =>
          groupMatchesQuery(row.id, titleOf, needle) ||
          (row.include?.some((pattern) => pattern.toLowerCase().includes(needle)) ?? false)
      : undefined,
    (list) => sortRows(list, sort, sortValueOf(titleOf)),
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
            const roots = shown.filter((row) => row.parent === undefined).length
            return [
              { value: roots, label: roots === 1 ? 'group' : 'groups' },
              { value: members.size, label: members.size === 1 ? 'repository' : 'repositories' },
              {
                value: shown.filter((row) => row.parent === undefined && row.counts.failing > 0)
                  .length,
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

const columnsFor = (
  titleOf: GroupTitleOf,
  tree: { open: ReadonlySet<string>; toggle: (id: string) => void } | undefined,
): readonly FleetColumn<GroupRow, GroupSortKey>[] => [
  {
    id: 'group',
    header: 'Group',
    sortKey: 'group',
    cell: (row) => (
      <div className="flex items-start gap-1.5">
        {row.parent === undefined && tree && row.subgroups.length ? (
          <Button
            variant="ghost"
            size="sm"
            isIconOnly
            className="size-7 min-w-7 shrink-0"
            aria-label={`${tree.open.has(row.id) ? 'Hide' : 'Show'} subgroups of ${titleOf(row.id)}`}
            aria-expanded={tree.open.has(row.id)}
            onPress={() => tree.toggle(row.id)}
          >
            {tree.open.has(row.id) ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
          </Button>
        ) : (
          <span className="inline-block w-7 shrink-0" />
        )}
        <div className={`flex flex-col gap-0.5 ${row.parent === undefined ? '' : 'ps-5'}`}>
          <span className="flex items-baseline gap-2">
            <Link
              to="/repos/groups/$groupId"
              params={{ groupId: row.id }}
              className="font-medium hover:underline"
            >
              {titleOf(row.id)}
            </Link>
            {row.subgroups.length ? (
              <span className="text-[11px] text-dim">
                {plural(row.subgroups.length, 'subgroup')}
              </span>
            ) : null}
          </span>
          {titleOf(row.id) !== row.id || row.forge ? (
            <span className="mono text-[11px] text-dim">
              {[titleOf(row.id) !== row.id ? row.id : undefined, row.parent ? undefined : row.forge]
                .filter(Boolean)
                .join(' · ')}
            </span>
          ) : null}
        </div>
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
