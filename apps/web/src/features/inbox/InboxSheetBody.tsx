import type {
  InboxAllowlistItem,
  InboxItem,
  InboxLearningItem,
  InboxReleaseItem,
  InboxTaskItem,
} from '@holtkeeper/api'
import { ExternalLink, RefreshCw } from 'lucide-react'
import { useState } from 'react'

import { useLearnings, useReleaseRepo, useTaskGroup, useTeamTitles } from '../../api/queries.ts'
import { formatDate, formatRelative, isoDay } from '../../lib/format.ts'
import { renewalDate } from '../../lib/inbox.ts'
import { learningTiming, originLabel, sourceLabel } from '../../lib/learnings.ts'
import { parseRepoKey } from '../../lib/repo.ts'
import { agentsLabel, ruleScopeLabel } from '../../lib/rules.ts'
import { Button, ErrorState, KeyValue, Placeholder, Tag, TextField } from '../../ui/index.ts'
import { BudgetWarningBody } from '../ai/BudgetWarning.tsx'
import { NextCard } from '../releases/NextCard.tsx'
import { TaskDetail, TaskGroupView } from '../tasks/TaskGroupView.tsx'
import { WritesOffNotice, useWritesOff } from '../tasks/WritesOff.tsx'
import type { Decide } from './decide.ts'

/** Tabs each kind's sheet offers, first one shown by default. */
export const sheetTabs: Record<InboxItem['kind'], readonly { id: string; label: string }[]> = {
  task: [
    { id: 'diff', label: 'Diff' },
    { id: 'plan', label: 'Plan' },
    { id: 'request', label: 'Context' },
    { id: 'repos', label: 'Repositories' },
  ],
  learning: [{ id: 'rule', label: 'Learning' }],
  release: [{ id: 'next', label: 'Next version' }],
  allowlist: [{ id: 'renew', label: 'Renewal' }],
  budget: [{ id: 'budget', label: 'Budget' }],
}

function Loading({ error }: { error: Error | null }) {
  return error ? <ErrorState error={error} /> : <Placeholder className="h-40" />
}

function TaskBody({ item, tab }: { item: InboxTaskItem; tab: string }) {
  const group = useTaskGroup(item.groupId)
  const [now] = useState(() => new Date())
  const [openTask, setOpenTask] = useState<string>()
  const writesOff = useWritesOff()
  if (!group.data) return <Loading error={group.error} />
  const detail = group.data
  if (tab === 'repos')
    return (
      <ul className="flex flex-col gap-4">
        {detail.tasks.map((task) => (
          <li key={task.id} className="flex flex-col gap-1">
            <span className="mono text-xs">{task.repo}</span>
            <TaskDetail
              task={task}
              now={now}
              {...(detail.taskPatches?.[task.id] && { patch: detail.taskPatches[task.id] })}
            />
          </li>
        ))}
      </ul>
    )
  return (
    <div className="flex flex-col gap-3">
      {writesOff ? <WritesOffNotice /> : null}
      <TaskGroupView
        group={detail}
        people={detail.people}
        section={tab === 'plan' || tab === 'request' ? tab : 'diff'}
        openTask={openTask}
        onOpenTask={setOpenTask}
      />
    </div>
  )
}

function LearningBody({ item }: { item: InboxLearningItem }) {
  const titleOf = useTeamTitles()
  const learnings = useLearnings({ status: ['pending'] })
  const learning = learnings.data?.learnings.find((each) => each.id === item.learningId)
  if (!learnings.data) return <Loading error={learnings.error} />
  if (!learning)
    return <p className="text-sm text-muted">This learning is no longer pending; it was decided.</p>
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] font-medium">{learning.text}</p>
      <KeyValue
        rows={[
          { label: 'Reason', value: learning.reason || null },
          {
            label: 'Scope',
            value: (
              <span className="flex flex-wrap items-center gap-1">
                {ruleScopeLabel(learning.scope, titleOf)}
                {(learning.files ?? []).map((glob) => (
                  <Tag key={glob} mono>
                    {glob}
                  </Tag>
                ))}
              </span>
            ),
          },
          { label: 'Agents', value: agentsLabel(learning.agents) },
          { label: 'Origin', value: originLabel(learning.origin) },
          {
            label: 'Activates',
            value: learningTiming(learning)?.label ?? formatRelative(item.activeAt),
          },
        ]}
      />
      <section className="flex flex-col gap-1.5">
        <h3 className="text-[11.5px] font-medium text-muted">Sources</h3>
        <ul className="flex flex-col gap-1 text-[12.5px]">
          {learning.sources.map((source, position) => (
            // oxlint-disable-next-line react/no-array-index-key
            <li key={`${source.noteId ?? source.at}:${position}`}>
              {source.url ? (
                <a
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                  className="mono inline-flex items-center gap-1 hover:underline"
                >
                  {sourceLabel(source)}
                  <ExternalLink className="size-3 text-muted" />
                </a>
              ) : (
                <span className="mono">{sourceLabel(source)}</span>
              )}
            </li>
          ))}
        </ul>
      </section>
      <p className="text-xs text-muted">
        Left alone it activates by itself after the approval delay. Approve to let agents use it
        now, or Reject to keep it out of the prompts.
      </p>
    </div>
  )
}

function ReleaseBody({ item }: { item: InboxReleaseItem }) {
  const repo = parseRepoKey(item.repo)
  const view = useReleaseRepo(repo)
  if (!repo || !view.data) return <Loading error={view.error} />
  return <NextCard repo={repo} view={view.data} compact />
}

function AllowlistBody({ item, decide }: { item: InboxAllowlistItem; decide: Decide }) {
  const [today] = useState(() => isoDay(new Date()))
  const [expires, setExpires] = useState(() => renewalDate(item.expires, today))
  const [reason, setReason] = useState(item.entry.reason)
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(expires) && expires >= today
  return (
    <div className="flex flex-col gap-4">
      <KeyValue
        rows={[
          { label: 'Advisory', value: <span className="mono">{item.entry.id}</span> },
          {
            label: 'Package',
            value: item.entry.package ? <span className="mono">{item.entry.package}</span> : null,
          },
          { label: 'Set on', value: item.scope },
          {
            label: 'Last day',
            value: (
              <Tag tone={item.expired ? 'danger' : 'warning'} dot>
                {item.expired ? 'Expired' : 'Expires'} {formatDate(`${item.expires}T00:00:00Z`)}
              </Tag>
            ),
          },
        ]}
      />
      <TextField label="Reason" value={reason} onChange={setReason} />
      <div className="flex items-end gap-2">
        <TextField
          label="New last day"
          type="date"
          value={expires}
          onChange={setExpires}
          className="min-w-0 flex-1"
          {...(valid ? {} : { error: 'Pick a day from today on' })}
        />
        <Button
          variant="primary"
          size="sm"
          isDisabled={!valid}
          onPress={() => decide(item, 'approve', { expires, reason })}
        >
          <RefreshCw className="size-3.5" />
          Renew
        </Button>
      </div>
      <p className="text-xs text-muted">
        Renewing rewrites the allowlist setting and follows the allowlist policy's maximum days and
        reason rule; the last write wins and the change is audited.
      </p>
    </div>
  )
}

/** The body of an Inbox item's sheet: what a person needs to decide it, per kind and tab. */
export function InboxSheetBody({
  item,
  tab,
  decide,
}: {
  item: InboxItem
  tab: string
  decide: Decide
}) {
  switch (item.kind) {
    case 'task':
      return <TaskBody item={item} tab={tab} />
    case 'learning':
      return <LearningBody item={item} />
    case 'release':
      return <ReleaseBody item={item} />
    case 'budget':
      return <BudgetWarningBody item={item} />
    default:
      return <AllowlistBody item={item} decide={decide} />
  }
}
