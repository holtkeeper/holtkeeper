import type { AgentTaskGroupView, PersonView } from '@holtkeeper/api'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { Bot, Check, ExternalLink, MessagesSquare, RotateCcw, Square, X } from 'lucide-react'
import { type ReactNode, useEffect, useEffectEvent, useMemo, useState } from 'react'

import { useRepos, useTaskGroup, useTaskGroups, useWriteTasks } from '../../api/queries.ts'
import { formatUsd } from '../../lib/ai-usage.ts'
import { neighbours } from '../../lib/flow.ts'
import { formatDateTime, formatRelative, plural, shortId } from '../../lib/format.ts'
import { personOf } from '../../lib/people.ts'
import { repoKey } from '../../lib/repo.ts'
import { sheetCommand } from '../../lib/sheet.ts'
import { isEditableTarget } from '../../lib/slash-focus.ts'
import {
  type TaskListFilter,
  type TaskSection,
  type TaskSheetTab,
  type TaskView,
  type TasksSearch,
  endedSummary,
  groupCiSummary,
  groupDiffstat,
  groupSpendCap,
  matchesTaskList,
  parseTaskSheetTab,
  parseTasksSearch,
  taskCiTone,
  taskFilterOptions,
  taskGroupTeams,
  taskKindLabel,
  taskProgressCaption,
  taskSectionCaption,
  taskSectionInfo,
  taskSectionOf,
  taskSections,
  taskSegments,
  taskSourceLabel,
  taskStatusLabel,
  taskStatusTone,
  taskViewCounts,
} from '../../lib/tasks.ts'
import { useNow } from '../../lib/use-now.ts'
import {
  Button,
  Count,
  EmptyState,
  ErrorState,
  FilterButton,
  Kbd,
  Legend,
  Page,
  Placeholder,
  SegmentBar,
  SegmentedTabs,
  SideSheet,
  Table,
  Tag,
  Td,
  Th,
  Tooltip,
  Tr,
  quietActionsOf,
} from '../../ui/index.ts'
import { copyLinkItem } from '../shell/copy-link.ts'
import { useScope } from '../shell/scope.ts'
import { useSession } from '../shell/session.ts'
import { type GroupDecisions, useGroupDecisions } from './decisions.tsx'
import { taskGroupProgressLabel } from './progress.ts'
import { MergeRequestLink, type SheetGroup, TaskGroupView } from './TaskGroupView.tsx'
import { WriteControl } from './WriteControl.tsx'

const columns = 9

const noFilter: TaskListFilter = { query: '', kinds: [], sources: [], repos: [], proposers: [] }

const viewLabel = (label: string, count: number) => (
  <>
    {label} <Count>{count}</Count>
  </>
)

const shownStatus = (group: AgentTaskGroupView) =>
  taskSectionOf(group) === 'failed' ? 'failed' : group.status

function Repos({ repos }: { repos: readonly string[] }) {
  const [first, ...rest] = repos
  return (
    <span className="mono block max-w-56 truncate text-xs" title={repos.join('\n')}>
      {first?.slice(first.indexOf(':') + 1)}
      {rest.length ? <span className="text-dim"> +{rest.length}</span> : null}
    </span>
  )
}

function RowAction({
  group,
  section,
  decisions,
}: {
  group: AgentTaskGroupView
  section: TaskSection
  decisions: GroupDecisions
}) {
  const busy = decisions.busy(group.id)
  if (section === 'approval')
    return (
      <span className="flex justify-end gap-1">
        {group.can.approve ? (
          <Button
            size="sm"
            variant="secondary"
            isDisabled={busy}
            onPress={() => decisions.ask('approve', group)}
          >
            Approve
          </Button>
        ) : null}
        {group.can.reject ? (
          <Button
            size="sm"
            variant="ghost"
            isDisabled={busy}
            onPress={() => decisions.ask('reject', group)}
          >
            Reject
          </Button>
        ) : null}
      </span>
    )
  if (section === 'failed' && group.can.retry)
    return (
      <Button size="sm" variant="secondary" isPending={busy} onPress={() => decisions.retry(group)}>
        Retry
      </Button>
    )
  if (section === 'running' && group.can.cancel)
    return (
      <Button
        size="sm"
        variant="ghost"
        isDisabled={busy}
        onPress={() => decisions.ask('cancel', group)}
      >
        Cancel
      </Button>
    )
  const mr = group.tasks.find((task) => task.mergeRequest)?.mergeRequest
  if (section === 'opened' && mr)
    return (
      <a
        href={mr.url}
        target="_blank"
        rel="noreferrer noopener"
        aria-label={`Open !${mr.id} on the forge`}
        onClick={(event) => event.stopPropagation()}
        className="inline-grid size-7 place-items-center rounded-md text-muted hover:bg-raise hover:text-foreground"
      >
        <ExternalLink className="size-3.5" />
      </a>
    )
  return null
}

function GroupRow({
  group,
  people,
  caps,
  now,
  open,
  onOpen,
  decisions,
}: {
  group: AgentTaskGroupView
  people: Record<string, PersonView>
  caps: Parameters<typeof groupSpendCap>[1]
  now: Date
  open: boolean
  onOpen: () => void
  decisions: GroupDecisions
}) {
  const section = taskSectionOf(group)
  const status = shownStatus(group)
  const opened = group.tasks.filter((task) => task.mergeRequest)
  const ci = groupCiSummary(group.tasks)
  const error = section === 'failed' ? group.tasks.find((task) => task.error)?.error : undefined
  const cap = section === 'approval' ? groupSpendCap(group, caps) : undefined
  return (
    <Tr selected={open} onClick={onOpen}>
      <Td className="whitespace-nowrap">
        <Tag tone={taskStatusTone[status]} dot>
          {taskStatusLabel[status]}
        </Tag>
      </Td>
      <Td className="min-w-60 whitespace-normal">
        <div className="font-medium">{group.title}</div>
        <div className={`mt-0.5 truncate text-xs ${error ? 'text-bad' : 'text-muted'}`}>
          {error ??
            `${taskKindLabel[group.kind]} · ${taskSourceLabel(group.source)} · ${personOf(people, group.proposedBy).name}`}
        </div>
      </Td>
      <Td>
        <Repos repos={group.repos} />
      </Td>
      <Td className="whitespace-nowrap">
        <span className="flex items-center gap-2">
          <span className="w-20">
            <SegmentBar segments={taskSegments(group.tasks)} total={group.tasks.length} />
          </span>
          <span className="text-xs text-muted">{taskProgressCaption(group.tasks)}</span>
        </span>
      </Td>
      <Td className="whitespace-nowrap">
        {opened.length ? (
          <span className="flex items-center gap-2">
            {opened.slice(0, 2).map((task) => (
              <MergeRequestLink key={task.id} task={task} />
            ))}
            {opened.length > 2 ? (
              <span className="text-xs text-dim">+{opened.length - 2}</span>
            ) : null}
          </span>
        ) : (
          <span className="text-dim">—</span>
        )}
      </Td>
      <Td className="whitespace-nowrap">
        {ci ? (
          <Tag tone={taskCiTone[ci.ci]} dot>
            {ci.label}
          </Tag>
        ) : (
          <span className="text-dim">—</span>
        )}
      </Td>
      <Td align="right" className="mono whitespace-nowrap text-xs tabular">
        {section === 'approval' ? (
          <span className="text-muted">{cap === undefined ? '—' : `≤ ${formatUsd(cap)}`}</span>
        ) : (
          formatUsd(group.costUsd)
        )}
      </Td>
      <Td className="whitespace-nowrap">
        <Tooltip content={formatDateTime(group.updatedAt)}>
          <time tabIndex={0} dateTime={group.updatedAt} className="text-xs text-muted">
            {formatRelative(group.updatedAt, now)}
          </time>
        </Tooltip>
      </Td>
      <Td align="right" className="whitespace-nowrap" onClick={(event) => event.stopPropagation()}>
        <RowAction group={group} section={section} decisions={decisions} />
      </Td>
    </Tr>
  )
}

function SectionHeader({
  section,
  count,
  caption,
}: {
  section: TaskSection
  count: number
  caption: string
}) {
  const info = taskSectionInfo[section]
  return (
    <tr>
      <th
        colSpan={columns}
        scope="rowgroup"
        className="border-b border-line bg-raise px-3.5 py-1.5 text-left text-xs font-normal"
      >
        <span className="flex flex-wrap items-center gap-2">
          <Tag tone={info.tone} dot>
            {info.label}
          </Tag>
          <Count>{count}</Count>
          <span className="text-muted">{caption}</span>
          {section === 'approval' ? (
            <Link
              to="/inbox"
              search={{ kind: 'task' }}
              className="ms-auto text-xs text-muted hover:text-foreground hover:underline"
            >
              Also in Inbox
            </Link>
          ) : null}
        </span>
      </th>
    </tr>
  )
}

function GroupSheet({
  group,
  people,
  tab,
  onTab,
  openTask,
  onOpenTask,
  onClose,
  decisions,
  ...position
}: {
  group: SheetGroup
  people: Record<string, PersonView>
  tab: TaskSheetTab
  onTab: (tab: TaskSheetTab) => void
  openTask: string | undefined
  onOpenTask: (id: string | undefined) => void
  onClose: () => void
  decisions: GroupDecisions
  index?: number
  total?: number
  onPrevious?: () => void
  onNext?: () => void
}) {
  const caps = useWriteTasks()
  const actions = [
    ...(group.can.approve
      ? [{ label: 'Approve and run', icon: Check, onPress: () => decisions.ask('approve', group) }]
      : []),
    ...(group.can.reject
      ? [{ label: 'Reject', icon: X, onPress: () => decisions.ask('reject', group) }]
      : []),
    ...(group.can.retry
      ? [{ label: 'Retry failed', icon: RotateCcw, onPress: () => decisions.retry(group) }]
      : []),
    ...(group.can.cancel
      ? [{ label: 'Cancel task', icon: Square, onPress: () => decisions.ask('cancel', group) }]
      : []),
  ]
  const quiet = quietActionsOf(actions)
  const rest = actions.slice(2)
  const diff = groupDiffstat(group.tasks)
  return (
    <SideSheet
      open
      onClose={onClose}
      id={`task ${shortId(group.id)}`}
      copyId={group.id}
      title={group.title}
      {...position}
      progress={{
        segments: taskSegments(group.tasks),
        total: group.tasks.length,
        label: taskGroupProgressLabel(group.tasks, group.costUsd, groupSpendCap(group, caps.data)),
      }}
      {...(quiet && { quietActions: quiet })}
      more={[
        ...rest.map((action) => ({
          label: action.label,
          icon: action.icon,
          onAction: action.onPress,
        })),
        ...(group.source.type === 'chat'
          ? [
              {
                label: 'Open the chat thread',
                icon: MessagesSquare,
                href: `/chat?thread=${encodeURIComponent(group.source.threadId)}`,
              },
            ]
          : []),
        copyLinkItem,
      ]}
      tabs={{
        items: [
          { id: 'plan', label: 'Plan' },
          { id: 'repos', label: 'Repositories', badge: group.tasks.length },
          { id: 'diff', label: 'Diff', ...(diff ? { badge: diff.files } : {}) },
          { id: 'runs', label: 'Agent runs' },
          { id: 'request', label: 'Request' },
          { id: 'flow', label: 'Flow' },
        ],
        selected: tab,
        onSelect: (id) => onTab(parseTaskSheetTab(id)),
        'aria-label': 'Task details',
      }}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Tag tone={taskStatusTone[shownStatus(group)]} dot>
            {taskStatusLabel[shownStatus(group)]}
          </Tag>
        </div>
        <TaskGroupView
          group={group}
          people={people}
          section={tab}
          onSection={onTab}
          openTask={openTask}
          onOpenTask={onOpenTask}
        />
      </div>
    </SideSheet>
  )
}

/**
 * Ops › Tasks: the write tasks control strip (the `tasks.write` switch behind a confirmation that
 * names the risks, the write pool, weekly spend and caps), then every task group the viewer may
 * see in sections Needs approval, Running, Opened MR, Failed and Ended, each row with progress,
 * merge requests, CI, spend and its next action (Approve and Reject, Cancel, Retry, open the merge
 * request). Scope, view, search and filters narrow the list. A row opens the group in the side
 * sheet (J/K step through the list) with Plan, Repositories, Diff, Agent runs, Request and Flow.
 */
export function TasksPage() {
  const search = useSearch({ from: '/app/ops/tasks' })
  const navigate = useNavigate({ from: '/ops/tasks' })
  const groups = useTaskGroups()
  const caps = useWriteTasks()
  const repos = useRepos()
  const { view: scopeView, setView: setScopeView, scope } = useScope()
  const decisions = useGroupDecisions()
  const { canGlobal } = useSession()
  const now = useNow()
  const [filter, setFilter] = useState<TaskListFilter>(noFilter)
  const [endedOpen, setEndedOpen] = useState(false)
  const view: TaskView = search.view ?? 'open'

  const set = (patch: Partial<Record<keyof TasksSearch, unknown>>) =>
    void navigate({ search: (previous) => parseTasksSearch({ ...previous, ...patch }) })

  const repoGroups = useMemo(
    () => new Map((repos.data?.repos ?? []).map((repo) => [repoKey(repo.repo), repo.groups])),
    [repos.data],
  )
  const all = groups.data?.groups ?? []
  const scoped = scope(all.map((group) => ({ group, groups: taskGroupTeams(group, repoGroups) })))
  const inScope = scoped.shown.map((each) => each.group)
  const listPeople = groups.data?.people ?? {}
  const options = taskFilterOptions(inScope, listPeople)
  const filtered = inScope.filter((group) => matchesTaskList(group, filter))
  const counts = taskViewCounts(filtered)
  const sections = taskSections(filtered, view)
  const ended = view === 'open' ? taskSections(filtered, 'ended')[0] : undefined
  const ordered = [
    ...sections.flatMap((section) => section.groups),
    ...(ended && endedOpen ? ended.groups : []),
  ]
  const ids = ordered.map((group) => group.id)
  const step = neighbours(ids, search.group)
  const detail = useTaskGroup(search.group)
  const open: SheetGroup | undefined = detail.data ?? all.find((group) => group.id === search.group)
  const people = { ...listPeople, ...detail.data?.people }
  const openGroup = (id: string | undefined) => set({ group: id, task: undefined, tab: undefined })
  const tab: TaskSheetTab = search.tab ?? (search.task ? 'repos' : 'plan')
  const runningRepos = filtered
    .filter((group) => taskSectionOf(group) !== 'ended')
    .reduce((sum, group) => sum + group.repos.length, 0)

  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (search.group !== undefined || event.isComposing || !ids.length) return
    const command = sheetCommand({
      key: event.key,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      editable: isEditableTarget(event.target),
    })
    if (command !== 'next' && command !== 'previous') return
    event.preventDefault()
    openGroup(command === 'next' ? ids[0] : ids.at(-1))
  })

  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey(event)
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])

  const rows = (list: readonly AgentTaskGroupView[]) =>
    list.map((group) => (
      <GroupRow
        key={group.id}
        group={group}
        people={listPeople}
        caps={caps.data}
        now={now}
        open={group.id === search.group}
        onOpen={() => openGroup(group.id)}
        decisions={decisions}
      />
    ))

  return (
    <Page
      crumbs={[{ label: 'Tasks' }]}
      {...(canGlobal('settings:read') && {
        configure: { link: { to: '/settings/$section', params: { section: 'ai' } } },
      })}
      more={[copyLinkItem]}
      primary={{ label: 'New task in Chat', icon: MessagesSquare, link: { to: '/chat' } }}
      scope={{ value: scopeView, onChange: setScopeView, counts: scoped.counts }}
      search={{
        value: filter.query,
        onChange: (query) => setFilter((previous) => ({ ...previous, query })),
        'aria-label': 'Filter tasks',
        placeholder: 'Filter by task, repository, MR',
      }}
      filters={
        <>
          <SegmentedTabs
            aria-label="View"
            selected={view}
            onSelect={(id) => set({ view: id })}
            items={[
              { id: 'open', label: viewLabel('Open', counts.open) },
              { id: 'ended', label: viewLabel('Ended', counts.ended) },
              { id: 'all', label: 'All' },
            ]}
          />
          <FilterButton
            label="Kind"
            options={options.kinds}
            value={filter.kinds}
            onChange={(kinds) => setFilter((previous) => ({ ...previous, kinds }))}
          />
          <FilterButton
            label="Source"
            options={options.sources}
            value={filter.sources}
            onChange={(sources) => setFilter((previous) => ({ ...previous, sources }))}
          />
          <FilterButton
            label="Repository"
            options={options.repos}
            value={filter.repos}
            onChange={(chosen) => setFilter((previous) => ({ ...previous, repos: chosen }))}
          />
          <FilterButton
            label="Proposed by"
            all="Anyone"
            options={options.proposers}
            value={filter.proposers}
            onChange={(proposers) => setFilter((previous) => ({ ...previous, proposers }))}
          />
        </>
      }
    >
      <WriteControl />
      <section className="overflow-hidden rounded-xl border border-line bg-panel text-[13px]">
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-3.5 py-2.5">
          <h2 className="text-[13px] font-semibold">
            Task groups
            <span className="ml-2 text-xs font-normal text-muted">
              one task per repository, each opens a draft merge request
            </span>
          </h2>
          <Legend
            className="ms-auto"
            label="Progress colors"
            items={[
              { tone: 'success', label: 'MR open' },
              { tone: 'info', label: 'Running' },
              { tone: 'default', label: 'Queued' },
              { tone: 'danger', label: 'Failed' },
            ]}
          />
        </div>
        {groups.isPending ? (
          <div className="flex flex-col gap-1 p-3">
            {Array.from({ length: 6 }, (_, i) => (
              <Placeholder key={i} className="h-9" />
            ))}
          </div>
        ) : groups.isError ? (
          <div className="p-3">
            <ErrorState error={groups.error} />
          </div>
        ) : !sections.length && !ended ? (
          <EmptyState
            icon={<Bot className="size-5" />}
            title={all.length ? 'Nothing here' : 'No tasks yet'}
            description={
              all.length
                ? 'Change the scope, the view or the filters to see more task groups.'
                : 'Tasks start from a chat task card, Roll out on a dependency upgrade or the MCP start_task tool.'
            }
          />
        ) : (
          <Table label="Task groups">
            <thead>
              <tr>
                <Th>Status</Th>
                <Th>Task</Th>
                <Th>Repositories</Th>
                <Th>Progress</Th>
                <Th>Merge requests</Th>
                <Th>CI</Th>
                <Th align="right">Spend</Th>
                <Th>Updated</Th>
                <Th align="right">
                  <span className="sr-only">Action</span>
                </Th>
              </tr>
            </thead>
            {sections.map((section) => (
              <SectionRowsFor
                key={section.id}
                id={section.id}
                groups={section.groups}
                rows={rows}
              />
            ))}
            {ended ? (
              <tbody>
                <tr>
                  <td colSpan={columns} className="border-b border-line px-3.5 py-2">
                    <button
                      type="button"
                      aria-expanded={endedOpen}
                      onClick={() => setEndedOpen((value) => !value)}
                      className="text-xs text-muted hover:text-foreground"
                    >
                      {endedOpen ? 'Hide ended' : 'Ended'} · {endedSummary(ended.groups)}
                    </button>
                  </td>
                </tr>
                {endedOpen ? rows(ended.groups) : null}
              </tbody>
            ) : null}
          </Table>
        )}
        <footer className="flex flex-wrap items-center gap-2 border-t border-line px-3.5 py-2.5 text-xs text-muted">
          <span>
            {plural(counts.open, 'open task group')} ·{' '}
            {plural(runningRepos, 'repository', 'repositories')} · tasks start from Chat, a
            dependency rollout or an agent over MCP
          </span>
          <span className="flex-1" />
          <span className="flex items-center gap-1.5">
            Navigate <Kbd>J</Kbd>
            <Kbd>K</Kbd> · open <Kbd>↵</Kbd>
          </span>
        </footer>
      </section>
      {decisions.dialogs}
      {search.group === undefined ? null : open ? (
        <GroupSheet
          key={open.id}
          group={open}
          people={people}
          tab={tab}
          onTab={(next) => set({ tab: next })}
          openTask={search.task}
          onOpenTask={(task) => set({ task, tab: 'repos' })}
          onClose={() => openGroup(undefined)}
          decisions={decisions}
          total={ids.length}
          {...(step.index >= 0 ? { index: step.index } : {})}
          {...(step.previous ? { onPrevious: () => openGroup(step.previous) } : {})}
          {...(step.next ? { onNext: () => openGroup(step.next) } : {})}
        />
      ) : (
        <SideSheet
          open
          onClose={() => openGroup(undefined)}
          id={`task ${shortId(search.group)}`}
          title="Task"
        >
          {detail.isError ? <ErrorState error={detail.error} /> : <Placeholder className="h-40" />}
        </SideSheet>
      )}
    </Page>
  )
}

function SectionRowsFor({
  id,
  groups,
  rows,
}: {
  id: TaskSection
  groups: readonly AgentTaskGroupView[]
  rows: (list: readonly AgentTaskGroupView[]) => ReactNode
}) {
  return (
    <tbody>
      <SectionHeader section={id} count={groups.length} caption={taskSectionCaption(id, groups)} />
      {rows(groups)}
    </tbody>
  )
}
