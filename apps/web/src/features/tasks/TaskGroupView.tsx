import type {
  AgentTaskGroupDetail,
  AgentTaskGroupView,
  AgentTaskView,
  PersonView,
} from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { ExternalLink, GitPullRequest } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useTaskGroupMutations, useWriteTasks } from '../../api/queries.ts'
import { formatCost } from '../../lib/chat.ts'
import { formatDateTime, formatRelative, plural } from '../../lib/format.ts'
import { personOf } from '../../lib/people.ts'
import {
  type TaskFlowNode,
  taskCiLabel,
  taskCiTone,
  taskGroupCap,
  taskGroupFlow,
  taskKindLabel,
  taskSegments,
  taskSourceLabel,
  taskStatusLabel,
  taskStatusTone,
} from '../../lib/tasks.ts'
import { type StatusTone, statusColor } from '../../ui/colors.ts'
import {
  Avatar,
  Button,
  ConfirmDialog,
  FlowCanvas,
  Markdown,
  SegmentBar,
  Tag,
  Tooltip,
  notify,
} from '../../ui/index.ts'
import { JobAgentRuns } from '../jobs/JobAgentRuns.tsx'

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-[11px] text-dim">{label}</dt>
      <dd className="min-w-0 truncate text-[13px]">{children}</dd>
    </div>
  )
}

function Section({
  title,
  aside,
  children,
}: {
  title: string
  aside?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="flex items-baseline justify-between gap-2 text-xs font-medium text-muted">
        {title}
        {aside}
      </h3>
      {children}
    </section>
  )
}

function Person({ people, id }: { people: Record<string, PersonView>; id: string }) {
  const person = personOf(people, id)
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Avatar src={person.avatarUrl} name={person.name} size="xs" />
      <span className="truncate">{person.name}</span>
    </span>
  )
}

function When({ at, now }: { at: string; now: Date }) {
  return (
    <Tooltip content={formatDateTime(at)}>
      <time tabIndex={0} dateTime={at} className="mono text-xs text-muted">
        {formatRelative(at, now)}
      </time>
    </Tooltip>
  )
}

/** A merge request link with its draft flag. */
export function MergeRequestLink({ task }: { task: Pick<AgentTaskView, 'mergeRequest'> }) {
  const mr = task.mergeRequest
  if (!mr) return null
  return (
    <a
      href={mr.url}
      target="_blank"
      rel="noreferrer noopener"
      className="mono inline-flex items-center gap-1 text-xs hover:underline"
    >
      <GitPullRequest aria-hidden className="size-3" />!{mr.id}
      {mr.draft ? <span className="text-muted">draft</span> : null}
      <ExternalLink aria-hidden className="size-3 text-muted" />
    </a>
  )
}

function NodeBox({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return (
    <div
      className="flex h-full min-w-0 flex-col justify-center gap-0.5 border-l-2 pl-2"
      style={{ borderColor: statusColor[tone] }}
    >
      {children}
    </div>
  )
}

function renderNode(node: TaskFlowNode) {
  switch (node.kind) {
    case 'source':
      return (
        <NodeBox tone={taskStatusTone[node.data.status]}>
          <span className="truncate text-[11px] text-muted">
            {taskKindLabel[node.data.kind]} · {taskSourceLabel(node.data.source)}
          </span>
          <span className="truncate text-xs font-medium">{node.data.title}</span>
        </NodeBox>
      )
    case 'repo':
      return (
        <NodeBox tone={taskStatusTone[node.data.task.status]}>
          <span className="mono truncate text-xs">{node.data.task.repo}</span>
          <span className="text-[11px] text-muted">
            {taskStatusLabel[node.data.task.status]}
            {node.data.task.costUsd !== undefined ? ` · ${formatCost(node.data.task.costUsd)}` : ''}
          </span>
        </NodeBox>
      )
    case 'mr': {
      const mr = node.data.task.mergeRequest
      return (
        <NodeBox tone={taskStatusTone[node.data.task.status]}>
          <span className="mono text-xs">!{mr?.id}</span>
          <span className="text-[11px] text-muted">
            {mr?.state ?? 'open'}
            {mr?.draft ? ' · draft' : ''}
          </span>
        </NodeBox>
      )
    }
    case 'ci':
      return (
        <NodeBox tone={taskCiTone[node.data.ci]}>
          <span className="text-xs">{taskCiLabel[node.data.ci]}</span>
        </NodeBox>
      )
    default:
      return (
        <NodeBox tone="warning">
          <span className="mono truncate text-xs">{node.data.repo}</span>
          <span className="truncate text-[11px] text-muted" title={node.data.reason}>
            asked for · {node.data.reason}
          </span>
        </NodeBox>
      )
  }
}

/** A task group as a read-only diagram: source, target repositories, merge requests, CI. */
/** Says that `tasks.write` is off, so approving starts nothing. */
export function WriteTasksOff() {
  return (
    <p className="mt-2 text-sm text-warn">
      Write tasks are turned off; an admin turns them on in Settings → System.
    </p>
  )
}

function TaskGroupFlow({ group }: { group: AgentTaskGroupView }) {
  const { nodes, edges } = taskGroupFlow(group)
  return (
    <FlowCanvas
      nodes={nodes}
      edges={edges}
      render={renderNode}
      aria-label={`How ${group.title} spreads over ${plural(group.tasks.length, 'repository', 'repositories')}`}
      maxHeight={360}
    />
  )
}

function PatchView({ patch, label }: { patch: string; label: string }) {
  return (
    <details>
      <summary className="cursor-pointer text-xs text-muted">{label}</summary>
      <pre className="mono mt-2 max-h-96 overflow-auto rounded-md border border-line bg-sunk p-2 text-[11px] whitespace-pre">
        {patch}
      </pre>
    </details>
  )
}

function TaskDetail({ task, now, patch }: { task: AgentTaskView; now: Date; patch?: string }) {
  const mutations = useTaskGroupMutations()
  const [cancelling, setCancelling] = useState(false)
  const live = task.status === 'queued' || task.status === 'running'
  return (
    <div className="flex flex-col gap-3 border-t border-line pt-3">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
        <Fact label="Branch">
          <span className="mono text-xs">{task.branch}</span>
        </Fact>
        <Fact label="Job">
          {task.jobId ? (
            <Link
              to="/jobs/$jobId"
              params={{ jobId: task.jobId }}
              className="mono text-xs hover:underline"
            >
              {task.jobId}
            </Link>
          ) : (
            <span className="text-dim">—</span>
          )}
        </Fact>
        <Fact label="Spend">
          <span className="mono text-xs">
            {task.costUsd !== undefined ? formatCost(task.costUsd) : '—'}
            {task.budgetUsd !== undefined ? ` of ${formatCost(task.budgetUsd)}` : ''}
          </span>
        </Fact>
        <Fact label="Updated">
          <When at={task.updatedAt} now={now} />
        </Fact>
      </dl>
      {task.mergeRequest ? (
        <div className="flex flex-wrap items-center gap-2">
          <MergeRequestLink task={task} />
          <Tag tone={taskCiTone[task.mergeRequest.ci ?? 'none']} dot>
            {taskCiLabel[task.mergeRequest.ci ?? 'none']}
          </Tag>
          {task.mergeRequest.checkedAt ? (
            <span className="text-[11px] text-dim">
              checked {formatRelative(task.mergeRequest.checkedAt, now)}
            </span>
          ) : null}
        </div>
      ) : null}
      {task.error ? <p className="text-xs text-bad">{task.error}</p> : null}
      {patch ? <PatchView patch={patch} label="Patch applied first" /> : null}
      {task.can.retry || task.can.cancel ? (
        <div className="flex gap-2">
          {task.can.retry ? (
            <Button
              size="sm"
              variant="secondary"
              isPending={mutations.retryTask.isPending}
              onPress={() =>
                mutations.retryTask.mutate(task.id, {
                  onSuccess: () => notify.success('Queued again on the write workers'),
                  onError: (error) => notify.error('Not started', messageOf(error)),
                })
              }
            >
              Retry
            </Button>
          ) : null}
          {task.can.cancel ? (
            <Button size="sm" variant="ghost" onPress={() => setCancelling(true)}>
              Cancel this repository
            </Button>
          ) : null}
        </div>
      ) : null}
      {task.jobId ? <JobAgentRuns jobId={task.jobId} live={live} /> : null}
      <ConfirmDialog
        isOpen={cancelling}
        onOpenChange={setCancelling}
        title={`Cancel the change in ${task.repo}?`}
        confirmLabel="Cancel it"
        isPending={mutations.cancelTask.isPending}
        onConfirm={() =>
          mutations.cancelTask.mutate(task.id, {
            onSuccess: () => setCancelling(false),
            onError: (error) => {
              setCancelling(false)
              notify.error('Not cancelled', messageOf(error))
            },
          })
        }
      >
        Its job stops; the other repositories of the task go on.
      </ConfirmDialog>
    </div>
  )
}

function TaskRow({
  task,
  open,
  onToggle,
  now,
  patch,
}: {
  task: AgentTaskView
  open: boolean
  onToggle: () => void
  now: Date
  patch?: string
}) {
  return (
    <li className="flex flex-col gap-2 border-b border-line py-2 last:border-b-0">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <Tag tone={taskStatusTone[task.status]} dot>
            {taskStatusLabel[task.status]}
          </Tag>
          <span className="mono truncate text-xs">{task.repo}</span>
        </button>
        <MergeRequestLink task={task} />
        {task.mergeRequest?.ci && task.mergeRequest.ci !== 'none' ? (
          <Tag tone={taskCiTone[task.mergeRequest.ci]}>{taskCiLabel[task.mergeRequest.ci]}</Tag>
        ) : null}
        <span className="mono w-14 shrink-0 text-right text-xs tabular text-muted">
          {task.costUsd !== undefined ? formatCost(task.costUsd) : '—'}
        </span>
      </div>
      {open ? <TaskDetail task={task} now={now} {...(patch && { patch })} /> : null}
    </li>
  )
}

function RepoRequest({
  groupId,
  request,
}: {
  groupId: string
  request: NonNullable<AgentTaskGroupView['requests']>[number]
}) {
  const mutations = useTaskGroupMutations()
  const decide = (approve: boolean) =>
    mutations.decide.mutate(
      { groupId, repo: request.repo, approve },
      { onError: (error) => notify.error('Not decided', messageOf(error)) },
    )
  return (
    <li className="flex flex-wrap items-center gap-2 text-xs">
      <Tag mono tone="warning">
        {request.repo}
      </Tag>
      <span className="min-w-0 flex-1 text-muted">{request.reason}</span>
      <Button
        size="sm"
        variant="ghost"
        isDisabled={mutations.decide.isPending}
        onPress={() => decide(false)}
      >
        Reject
      </Button>
      <Button
        size="sm"
        variant="secondary"
        isDisabled={mutations.decide.isPending}
        onPress={() => decide(true)}
      >
        Add
      </Button>
    </li>
  )
}

/**
 * One task group in the side sheet: who proposed and approved it with Approve and Cancel, its
 * plan, spend against the cap, the read-only diagram, pending repository requests and every
 * repository's task, which opens its merge request, CI, job and agent transcript with Retry and
 * Cancel.
 */
export function TaskGroupView({
  group,
  people,
  openTask,
  onOpenTask,
}: {
  group: AgentTaskGroupView & Partial<Pick<AgentTaskGroupDetail, 'patch' | 'taskPatches'>>
  people: Record<string, PersonView>
  openTask: string | undefined
  onOpenTask: (id: string | undefined) => void
}) {
  const [now] = useState(() => new Date())
  const mutations = useTaskGroupMutations()
  const caps = useWriteTasks()
  const [confirm, setConfirm] = useState<'approve' | 'cancel'>()
  const budgets = group.tasks.flatMap((task) =>
    task.budgetUsd === undefined ? [] : [task.budgetUsd],
  )
  const cap =
    budgets.length === group.tasks.length && budgets.length > 0
      ? budgets.reduce((sum, value) => sum + value, 0)
      : caps.data
        ? taskGroupCap(caps.data, group.tasks.length).total
        : undefined
  const pending = (group.requests ?? []).filter((request) => request.status === 'pending')
  const close = () => setConfirm(undefined)
  const switchedOff = caps.data?.enabled === false

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <Tag tone={taskStatusTone[group.status]} dot>
          {taskStatusLabel[group.status]}
        </Tag>
        <Tag>{taskKindLabel[group.kind]}</Tag>
        <span className="text-xs text-muted">{taskSourceLabel(group.source)}</span>
        {group.hasPatch ? <Tag tone="code">patch first</Tag> : null}
        <div className="ml-auto flex gap-2">
          {group.can.cancel ? (
            <Button size="sm" variant="ghost" onPress={() => setConfirm('cancel')}>
              Cancel
            </Button>
          ) : null}
          {group.can.approve ? (
            <Button size="sm" variant="primary" onPress={() => setConfirm('approve')}>
              Approve
            </Button>
          ) : null}
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
        <Fact label="Proposed">
          <span className="flex items-center gap-2">
            <Person people={people} id={group.proposedBy} />
            <When at={group.createdAt} now={now} />
          </span>
        </Fact>
        <Fact label="Approved">
          {group.approvedBy && group.approvedAt ? (
            <span className="flex items-center gap-2">
              <Person people={people} id={group.approvedBy} />
              <When at={group.approvedAt} now={now} />
            </span>
          ) : (
            <span className="text-muted">waiting</span>
          )}
        </Fact>
        <Fact label="Budget">
          <span className="text-xs">
            {group.budgetClass === 'interactive' ? 'Interactive' : 'Automatic'}
          </span>
        </Fact>
      </dl>
      {switchedOff && group.can.approve ? <WriteTasksOff /> : null}

      <Section
        title="Progress"
        aside={
          <span className="mono text-foreground">
            {formatCost(group.costUsd)}
            {cap !== undefined ? <span className="text-muted"> of {formatCost(cap)}</span> : null}
          </span>
        }
      >
        <SegmentBar segments={taskSegments(group.tasks)} total={group.tasks.length} />
      </Section>

      <Section title="Plan">
        <Markdown text={group.plan ?? group.prompt} className="text-[13px]" />
        {group.plan && group.prompt ? (
          <details>
            <summary className="cursor-pointer text-xs text-muted">Request</summary>
            <Markdown text={group.prompt} className="mt-2 text-[13px] text-muted" />
          </details>
        ) : null}
        {group.patch ? <PatchView patch={group.patch} label="Patch applied first" /> : null}
      </Section>

      <Section title="Flow">
        <TaskGroupFlow group={group} />
      </Section>

      {pending.length ? (
        <Section title="Asked to add">
          <ul className="flex flex-col gap-2">
            {pending.map((request) => (
              <RepoRequest key={request.repo} groupId={group.id} request={request} />
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title={plural(group.tasks.length, 'repository', 'repositories')}>
        <ul>
          {group.tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              now={now}
              open={openTask === task.id}
              {...(group.taskPatches?.[task.id] && { patch: group.taskPatches[task.id] })}
              onToggle={() => onOpenTask(openTask === task.id ? undefined : task.id)}
            />
          ))}
        </ul>
      </Section>

      <ConfirmDialog
        isOpen={confirm === 'approve'}
        onOpenChange={(open) => !open && close()}
        title="Run this change?"
        confirmLabel="Approve and run"
        isPending={mutations.approve.isPending}
        isDisabled={switchedOff}
        onConfirm={() =>
          mutations.approve.mutate(group.id, {
            onSuccess: () => {
              close()
              notify.success('Queued on the write workers')
            },
            onError: (error) => {
              close()
              notify.error('Not started', messageOf(error))
            },
          })
        }
      >
        An agent changes {plural(group.tasks.length, 'repository', 'repositories')} and opens draft
        merge requests for review. It runs as your request
        {cap !== undefined ? `, capped at ${formatCost(cap)}` : ''}.
        {switchedOff ? <WriteTasksOff /> : null}
      </ConfirmDialog>
      <ConfirmDialog
        isOpen={confirm === 'cancel'}
        onOpenChange={(open) => !open && close()}
        title="Cancel this task?"
        confirmLabel="Cancel it"
        isPending={mutations.cancel.isPending}
        onConfirm={() =>
          mutations.cancel.mutate(group.id, {
            onSuccess: close,
            onError: (error) => {
              close()
              notify.error('Not cancelled', messageOf(error))
            },
          })
        }
      >
        Queued and running repositories stop. Merge requests already open stay; close them on the
        forge.
      </ConfirmDialog>
    </div>
  )
}
