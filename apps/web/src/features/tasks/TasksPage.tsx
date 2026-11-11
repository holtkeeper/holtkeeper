import type { AgentTaskGroupView } from '@holtkeeper/api'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { Bot } from 'lucide-react'
import { useState } from 'react'

import { useTaskGroup, useTaskGroups } from '../../api/queries.ts'
import { formatCost } from '../../lib/chat.ts'
import { formatDateTime, formatRelative } from '../../lib/format.ts'
import {
  type TaskFilter,
  type TasksSearch,
  matchesTaskFilter,
  parseTasksSearch,
  taskKindLabel,
  taskSegments,
  taskSourceLabel,
  taskStatusLabel,
  taskStatusTone,
} from '../../lib/tasks.ts'
import {
  EmptyState,
  ErrorState,
  Placeholder,
  Page,
  SegmentBar,
  SegmentedTabs,
  SideSheet,
  Tag,
} from '../../ui/index.ts'
import { MergeRequestLink, TaskGroupView } from './TaskGroupView.tsx'

const rowGrid =
  'grid grid-cols-[96px_minmax(0,1fr)_64px] items-center gap-x-3 md:grid-cols-[104px_minmax(0,1fr)_minmax(0,200px)_96px_minmax(0,120px)_64px_80px]'

const filterTabs: { id: TaskFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'In progress' },
  { id: 'mr-open', label: 'MR open' },
  { id: 'ended', label: 'Ended' },
]

function Repos({ repos }: { repos: readonly string[] }) {
  const [first, ...rest] = repos
  return (
    <span
      className="mono hidden min-w-0 truncate text-xs text-muted md:block"
      title={repos.join('\n')}
    >
      {first}
      {rest.length ? <span className="text-dim"> +{rest.length}</span> : null}
    </span>
  )
}

function GroupRow({
  group,
  now,
  onOpen,
}: {
  group: AgentTaskGroupView
  now: Date
  onOpen: () => void
}) {
  const opened = group.tasks.filter((task) => task.mergeRequest)
  return (
    <li
      className={`${rowGrid} min-h-10 border-b border-line px-3 py-1.5 last:border-b-0 hover:bg-raise`}
    >
      <button type="button" onClick={onOpen} className="text-left">
        <Tag tone={taskStatusTone[group.status]} dot>
          {taskStatusLabel[group.status]}
        </Tag>
      </button>
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-col text-left">
        <span className="truncate font-medium">{group.title}</span>
        <span className="truncate text-[11px] text-muted">
          {taskKindLabel[group.kind]} · {taskSourceLabel(group.source)}
        </span>
      </button>
      <Repos repos={group.repos} />
      <span className="hidden md:block">
        <SegmentBar segments={taskSegments(group.tasks)} total={group.tasks.length} />
      </span>
      <span className="hidden min-w-0 flex-wrap gap-x-2 md:flex">
        {opened.slice(0, 2).map((task) => (
          <MergeRequestLink key={task.id} task={task} />
        ))}
        {opened.length > 2 ? <span className="text-xs text-dim">+{opened.length - 2}</span> : null}
      </span>
      <span className="mono text-right text-xs tabular">{formatCost(group.costUsd)}</span>
      <time
        dateTime={group.updatedAt}
        title={formatDateTime(group.updatedAt)}
        className="mono hidden truncate text-right text-xs text-muted md:block"
      >
        {formatRelative(group.updatedAt, now)}
      </time>
    </li>
  )
}

/**
 * Agent write tasks: every task group the caller may see with status, repositories, progress,
 * merge requests and spend, filtered by what still works, open merge requests or ended ones. A
 * row opens the group in the side sheet (J/K step through the list) with its approvals, plan,
 * diagram and each repository's task.
 */
export function TasksPage() {
  const search = useSearch({ from: '/app/tasks' })
  const navigate = useNavigate({ from: '/tasks' })
  const groups = useTaskGroups()
  const [now] = useState(() => new Date())
  const filter: TaskFilter = search.filter ?? 'all'

  const set = (patch: Partial<Record<keyof TasksSearch, unknown>>) =>
    void navigate({ search: (previous) => parseTasksSearch({ ...previous, ...patch }) })

  const list = (groups.data?.groups ?? []).filter((group) => matchesTaskFilter(group, filter))
  const index = list.findIndex((group) => group.id === search.group)
  const detail = useTaskGroup(search.group)
  const open = detail.data ?? (index >= 0 ? list[index] : undefined)
  const people = { ...groups.data?.people, ...detail.data?.people }
  const openGroup = (id: string | undefined) => set({ group: id, task: undefined })
  const previous = index > 0 ? list[index - 1] : undefined
  const next = index >= 0 ? list[index + 1] : undefined

  return (
    <Page
      title="Tasks"
      icon="jobs"
      description="Changes agents make on write workers: one task per repository, opened as draft merge requests"
    >
      <SegmentedTabs
        aria-label="Task filter"
        selected={filter}
        onSelect={(id) => set({ filter: id })}
        items={filterTabs}
      />
      <section className="overflow-hidden rounded-xl border border-line bg-panel text-[13px]">
        <div
          className={`${rowGrid} hidden border-b border-line px-3 py-2 text-xs text-dim md:grid`}
          aria-hidden
        >
          <span>Status</span>
          <span>Task</span>
          <span>Repositories</span>
          <span>Progress</span>
          <span>Merge requests</span>
          <span className="text-right">Spend</span>
          <span className="text-right">Updated</span>
        </div>
        {groups.isPending ? (
          <div className="flex flex-col gap-1 p-3">
            {Array.from({ length: 6 }, (_, i) => (
              <Placeholder key={i} className="h-8" />
            ))}
          </div>
        ) : groups.isError ? (
          <div className="p-3">
            <ErrorState error={groups.error} />
          </div>
        ) : list.length === 0 ? (
          <EmptyState
            icon={<Bot className="size-5" />}
            title={filter === 'all' ? 'No tasks yet' : 'Nothing here'}
            description="Tasks start from a chat task card, Roll out on a dependency upgrade or the MCP start_task tool."
          />
        ) : (
          <ul>
            {list.map((group) => (
              <GroupRow key={group.id} group={group} now={now} onOpen={() => openGroup(group.id)} />
            ))}
          </ul>
        )}
      </section>
      <SideSheet
        open={search.group !== undefined}
        onClose={() => openGroup(undefined)}
        id={search.group}
        title={open?.title ?? 'Task'}
        {...(index >= 0 ? { index, total: list.length } : {})}
        {...(previous ? { onPrevious: () => openGroup(previous.id) } : {})}
        {...(next ? { onNext: () => openGroup(next.id) } : {})}
      >
        {open ? (
          <TaskGroupView
            key={open.id}
            group={open}
            people={people}
            openTask={search.task}
            onOpenTask={(task) => set({ task })}
          />
        ) : detail.isError ? (
          <ErrorState error={detail.error} />
        ) : (
          <Placeholder className="h-40" />
        )}
      </SideSheet>
    </Page>
  )
}
