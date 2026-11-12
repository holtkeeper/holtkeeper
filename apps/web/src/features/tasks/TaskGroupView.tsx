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
import { formatUsd } from '../../lib/ai-usage.ts'
import { formatDateTime, formatRelative, plural, shortId } from '../../lib/format.ts'
import { personOf } from '../../lib/people.ts'
import {
  type Diffstat,
  type TaskFlowNode,
  type TaskSheetTab,
  diffstatShares,
  formatDiffstat,
  groupDiffstat,
  patchFiles,
  taskCiLabel,
  taskCiTone,
  taskGroupFlow,
  taskKindLabel,
  taskSourceLabel,
  taskStatusLabel,
  taskStatusTone,
} from '../../lib/tasks.ts'
import { useNow } from '../../lib/use-now.ts'
import { type StatusTone, statusColor } from '../../ui/colors.ts'
import {
  Avatar,
  Button,
  ConfirmDialog,
  EmptyState,
  FlowCanvas,
  KeyValue,
  Markdown,
  Tag,
  Tooltip,
  notify,
} from '../../ui/index.ts'
import { JobAgentRuns } from '../jobs/JobAgentRuns.tsx'

function Section({
  title,
  aside,
  children,
}: {
  title: ReactNode
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

function RepoName({ repo }: { repo: string }) {
  const at = repo.indexOf(':')
  const forge = repo.slice(0, at)
  const path = repo.slice(at + 1)
  return at > 0 ? (
    <Link
      to="/repos/$"
      params={{ _splat: `${forge}/${path}` }}
      className="mono min-w-0 truncate text-xs hover:underline"
      title={repo}
    >
      {path}
    </Link>
  ) : (
    <span className="mono min-w-0 truncate text-xs">{repo}</span>
  )
}

/** Says that `tasks.write` is off, so approving or retrying starts nothing. */
export function WriteTasksOff() {
  return (
    <p className="mt-2 text-sm text-warn">
      Agents may not change code right now; an admin turns it on at the top of Ops › Tasks.
    </p>
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
      onClick={(event) => event.stopPropagation()}
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
            {node.data.task.costUsd !== undefined ? ` · ${formatUsd(node.data.task.costUsd)}` : ''}
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
          <span className="text-xs">CI {taskCiLabel[node.data.ci].toLowerCase()}</span>
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

/** A patch in monospace under a summary line; collapsed unless `open`. */
function PatchView({
  patch,
  label,
  open = false,
}: {
  patch: string
  label: string
  open?: boolean
}) {
  return (
    <details open={open}>
      <summary className="cursor-pointer text-xs text-muted">{label}</summary>
      <pre className="mono mt-2 max-h-96 overflow-auto rounded-md border border-line bg-sunk p-2 text-[11px] whitespace-pre">
        {patch}
      </pre>
    </details>
  )
}

function DiffBar({ stat, max }: { stat: Pick<Diffstat, 'additions' | 'deletions'>; max: number }) {
  const shares = diffstatShares(stat, max)
  return (
    <span aria-hidden className="flex h-1.5 w-20 shrink-0 gap-px overflow-hidden rounded-sm">
      <i className="block bg-ok" style={{ flex: shares.add }} />
      <i className="block bg-bad" style={{ flex: shares.del }} />
      <i className="block bg-line" style={{ flex: shares.rest }} />
    </span>
  )
}

function DiffNumbers({ stat }: { stat: Pick<Diffstat, 'additions' | 'deletions'> }) {
  return (
    <span className="mono shrink-0 text-[11.5px] tabular">
      <span className="text-ok">+{stat.additions}</span>{' '}
      <span className="text-bad">−{stat.deletions}</span>
    </span>
  )
}

/** Per-file rows of a patch with their bars, the first `limit` of them. */
function PatchFiles({ patch, limit }: { patch: string; limit?: number }) {
  const files = patchFiles(patch)
  if (!files.length) return null
  const max = Math.max(...files.map((file) => file.additions + file.deletions))
  const shown = limit === undefined ? files : files.slice(0, limit)
  return (
    <ul className="flex flex-col gap-1">
      {shown.map((file) => (
        <li key={file.path} className="flex min-w-0 items-center gap-3 text-xs">
          <span className="mono min-w-0 flex-1 truncate" title={file.path}>
            {file.path}
          </span>
          <DiffNumbers stat={file} />
          <DiffBar stat={file} max={max} />
        </li>
      ))}
      {shown.length < files.length ? (
        <li className="text-xs text-dim">+ {plural(files.length - shown.length, 'more file')}</li>
      ) : null}
    </ul>
  )
}

/**
 * One repository's task: branch, job, spend, merge request with CI, error, the patch applied
 * first, Retry and Cancel when allowed, and the agent's runs.
 */
export function TaskDetail({
  task,
  now,
  patch,
}: {
  task: AgentTaskView
  now: Date
  patch?: string
}) {
  const mutations = useTaskGroupMutations()
  const [cancelling, setCancelling] = useState(false)
  return (
    <div className="flex flex-col gap-3 border-t border-line pt-3">
      <KeyValue
        labelWidth={72}
        rows={[
          { label: 'Branch', value: <span className="mono text-xs">{task.branch}</span> },
          {
            label: 'Job',
            value: task.jobId ? (
              <Link
                to="/ops/runs/$jobId"
                params={{ jobId: task.jobId }}
                className="mono text-xs hover:underline"
              >
                {shortId(task.jobId)}
              </Link>
            ) : (
              <span className="text-dim">—</span>
            ),
          },
          {
            label: 'Spend',
            value: (
              <span className="mono text-xs">
                {task.costUsd !== undefined ? formatUsd(task.costUsd) : '—'}
                {task.budgetUsd !== undefined ? ` of ${formatUsd(task.budgetUsd)}` : ''}
              </span>
            ),
          },
          { label: 'Updated', value: <When at={task.updatedAt} now={now} /> },
          ...(task.mergeRequest
            ? [
                {
                  label: 'CI',
                  value: (
                    <>
                      <Tag tone={taskCiTone[task.ci]} dot>
                        {taskCiLabel[task.ci]}
                      </Tag>
                      {task.mergeRequest.checkedAt ? (
                        <span className="text-[11px] text-dim">
                          checked {formatRelative(task.mergeRequest.checkedAt, now)}
                        </span>
                      ) : null}
                    </>
                  ),
                },
              ]
            : []),
        ]}
      />
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
              Retry this repository
            </Button>
          ) : null}
          {task.can.cancel ? (
            <Button size="sm" variant="ghost" onPress={() => setCancelling(true)}>
              Cancel this repository
            </Button>
          ) : null}
        </div>
      ) : null}
      {task.jobId ? (
        <JobAgentRuns
          jobId={task.jobId}
          live={task.status === 'queued' || task.status === 'running'}
        />
      ) : null}
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
        {task.mergeRequest ? (
          <Tag tone={taskCiTone[task.ci]}>CI {taskCiLabel[task.ci].toLowerCase()}</Tag>
        ) : null}
        <span className="mono w-14 shrink-0 text-right text-xs tabular text-muted">
          {task.costUsd !== undefined ? formatUsd(task.costUsd) : '—'}
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
    <li className="flex flex-col gap-1.5 rounded-lg border border-line bg-raise p-2.5 text-xs">
      <span>
        <span className="mono">{request.repo}</span> asked to join
      </span>
      <span className="text-muted">{request.reason}</span>
      <span className="flex gap-1.5">
        <Button
          size="sm"
          variant="secondary"
          isDisabled={mutations.decide.isPending}
          onPress={() => decide(true)}
        >
          Add
        </Button>
        <Button
          size="sm"
          variant="ghost"
          isDisabled={mutations.decide.isPending}
          onPress={() => decide(false)}
        >
          Reject
        </Button>
      </span>
    </li>
  )
}

/** A task group as the sheet reads it: the list view, with the patches once its detail loaded. */
export type SheetGroup = AgentTaskGroupView &
  Partial<Pick<AgentTaskGroupDetail, 'patch' | 'taskPatches'>>

function PlanTab({
  group,
  people,
  now,
  onTab,
}: {
  group: SheetGroup
  people: Record<string, PersonView>
  now: Date
  onTab: (tab: TaskSheetTab) => void
}) {
  const caps = useWriteTasks()
  const pending = (group.requests ?? []).filter((request) => request.status === 'pending')
  const stat = groupDiffstat(group.tasks)
  const switchedOff = caps.data?.enabled === false
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <Tag>{taskKindLabel[group.kind]}</Tag>
        <span className="text-xs text-muted">{taskSourceLabel(group.source)}</span>
        {group.hasPatch ? (
          <Tag tone="code" mono>
            patch first
          </Tag>
        ) : null}
      </div>
      {switchedOff && group.can.approve ? <WriteTasksOff /> : null}

      <Section title={group.plan ? 'Plan · written by the agent from the request' : 'Request'}>
        <Markdown text={group.plan ?? group.prompt} className="text-[13px]" />
      </Section>

      {group.patch || stat ? (
        <Section
          title="Expected diff"
          aside={
            stat ? (
              <span className="mono text-xs text-foreground">{formatDiffstat(stat)}</span>
            ) : undefined
          }
        >
          {group.patch ? (
            <PatchFiles patch={group.patch} limit={6} />
          ) : (
            <span className="text-xs text-muted">
              From {plural(stat!.repos, 'repository', 'repositories')} so far
            </span>
          )}
          <button
            type="button"
            className="self-start text-xs text-muted hover:underline"
            onClick={() => onTab('diff')}
          >
            Open Diff
          </button>
        </Section>
      ) : null}

      {pending.length ? (
        <ul className="flex flex-col gap-2">
          {pending.map((request) => (
            <RepoRequest key={request.repo} groupId={group.id} request={request} />
          ))}
        </ul>
      ) : null}

      <Section title="Repositories">
        <ul className="flex flex-col">
          {group.tasks.map((task) => (
            <li
              key={task.id}
              className="flex min-w-0 items-center gap-2 border-b border-line py-1.5 last:border-b-0"
            >
              <span className="min-w-0 flex-1">
                <RepoName repo={task.repo} />
              </span>
              {task.diffstat ? (
                <span className="text-[11.5px] text-muted">
                  {plural(task.diffstat.files, 'file')}
                </span>
              ) : null}
              <Tag tone={taskStatusTone[task.status]}>{taskStatusLabel[task.status]}</Tag>
              <span className="mono w-14 text-right text-xs text-muted">
                {task.budgetUsd !== undefined ? formatUsd(task.budgetUsd) : ''}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Task">
        <KeyValue
          rows={[
            {
              label: 'Proposed',
              value: (
                <>
                  <Person people={people} id={group.proposedBy} />
                  <When at={group.createdAt} now={now} />
                </>
              ),
            },
            {
              label: 'Approved',
              value:
                group.approvedBy && group.approvedAt ? (
                  <>
                    <Person people={people} id={group.approvedBy} />
                    <When at={group.approvedAt} now={now} />
                  </>
                ) : group.status === 'proposed' ? (
                  <span className="text-muted">
                    <span className="text-warn">Waiting</span> · anyone with{' '}
                    <code className="mono">tasks:run</code> on every repository
                    {group.can.approve ? ', you included' : ''}
                  </span>
                ) : (
                  <span className="text-dim">—</span>
                ),
            },
            ...(group.cancelledBy
              ? [{ label: 'Stopped by', value: <Person people={people} id={group.cancelledBy} /> }]
              : []),
            {
              label: 'Budget',
              value: (
                <span className="text-xs">
                  {group.budgetClass === 'interactive' ? 'Interactive' : 'Automatic'}
                  <span className="text-muted"> · from the weekly AI budget</span>
                </span>
              ),
            },
            ...(group.tasks[0]
              ? [
                  {
                    label: 'Branch',
                    value: <span className="mono text-xs">{group.tasks[0].branch}</span>,
                  },
                ]
              : []),
            ...(caps.data
              ? [
                  {
                    label: 'Write switch',
                    value: (
                      <Tag tone={caps.data.enabled ? 'success' : 'default'} dot>
                        {caps.data.enabled ? 'On' : 'Off'}
                      </Tag>
                    ),
                  },
                ]
              : []),
          ]}
        />
      </Section>
    </div>
  )
}

function DiffTab({ group }: { group: SheetGroup }) {
  const stat = groupDiffstat(group.tasks)
  const known = group.tasks.flatMap((task) =>
    task.diffstat ? [{ task, stat: task.diffstat }] : [],
  )
  const max = Math.max(0, ...known.map((each) => each.stat.additions + each.stat.deletions))
  if (!stat && !group.patch)
    return (
      <EmptyState
        title="No diff yet"
        description="The size of the change shows once a merge request opens or the task carries a patch."
      />
    )
  return (
    <div className="flex flex-col gap-5">
      {stat ? (
        <Section
          title="Merge requests"
          aside={<span className="mono text-xs text-foreground">{formatDiffstat(stat)}</span>}
        >
          <ul className="flex flex-col gap-1.5">
            {known.map(({ task, stat: each }) => (
              <li key={task.id} className="flex min-w-0 items-center gap-3 text-xs">
                <span className="min-w-0 flex-1">
                  <RepoName repo={task.repo} />
                </span>
                <span className="text-muted">
                  {plural(each.files, 'file')}
                  {each.source === 'patch' ? ' · patch' : ''}
                </span>
                <DiffNumbers stat={each} />
                <DiffBar stat={each} max={max} />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {group.patch ? (
        <Section title="Patch applied first">
          <PatchFiles patch={group.patch} />
          <PatchView patch={group.patch} label="Show the patch" />
        </Section>
      ) : null}
    </div>
  )
}

function RunsTab({ group }: { group: SheetGroup }) {
  const started = group.tasks.flatMap((task) => (task.jobId ? [{ task, jobId: task.jobId }] : []))
  if (!started.length)
    return (
      <EmptyState
        title="No agent has run yet"
        description="Each repository gets a write job once the task is approved; its agent runs and transcripts show here."
      />
    )
  return (
    <div className="flex flex-col gap-5">
      {started.map(({ task, jobId }) => (
        <Section
          key={task.id}
          title={<RepoName repo={task.repo} />}
          aside={
            <Link to="/ops/runs/$jobId" params={{ jobId }} className="mono text-xs hover:underline">
              {shortId(jobId)}
            </Link>
          }
        >
          <JobAgentRuns
            jobId={jobId}
            live={task.status === 'queued' || task.status === 'running'}
          />
        </Section>
      ))}
    </div>
  )
}

function RequestTab({
  group,
  people,
  now,
}: {
  group: SheetGroup
  people: Record<string, PersonView>
  now: Date
}) {
  return (
    <div className="flex flex-col gap-5">
      <KeyValue
        rows={[
          {
            label: 'From',
            value:
              group.source.type === 'chat' ? (
                <Link
                  to="/chat"
                  search={{ thread: group.source.threadId }}
                  className="text-xs hover:underline"
                >
                  Chat thread
                </Link>
              ) : (
                <span className="text-xs">{taskSourceLabel(group.source)}</span>
              ),
          },
          {
            label: 'Asked by',
            value: (
              <>
                <Person people={people} id={group.proposedBy} />
                <When at={group.createdAt} now={now} />
              </>
            ),
          },
          { label: 'Repositories', value: <span className="text-xs">{group.repos.length}</span> },
        ]}
      />
      <Section title="What the agent was asked">
        <Markdown text={group.prompt} className="text-[13px]" />
      </Section>
    </div>
  )
}

/**
 * One task group in a tab of the side sheet. Plan: the plan, the expected diff, repositories that
 * asked to join, the repositories with their caps, and who proposed it, who may approve it and
 * who did. Repositories: every repository's task, which opens its merge request, CI, job and
 * Retry and Cancel. Diff: the diffstat per repository and of the patch. Agent runs: each
 * repository's agent transcripts. Request: what was asked, by whom and from where. Flow: the
 * read-only diagram.
 */
export function TaskGroupView({
  group,
  people,
  section,
  onSection = () => {},
  openTask,
  onOpenTask,
}: {
  group: SheetGroup
  people: Record<string, PersonView>
  section: TaskSheetTab
  /** Switches the sheet to another tab, e.g. Open Diff on the Plan tab. */
  onSection?: (tab: TaskSheetTab) => void
  openTask: string | undefined
  onOpenTask: (id: string | undefined) => void
}) {
  const now = useNow()
  switch (section) {
    case 'flow': {
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
    case 'diff':
      return <DiffTab group={group} />
    case 'runs':
      return <RunsTab group={group} />
    case 'request':
      return <RequestTab group={group} people={people} now={now} />
    case 'repos':
      return (
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
      )
    default:
      return <PlanTab group={group} people={people} now={now} onTab={onSection} />
  }
}
