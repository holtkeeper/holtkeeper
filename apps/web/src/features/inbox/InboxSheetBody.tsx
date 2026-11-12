import type {
  GuideScopeKey,
  GuideTask,
  InboxAllowlistItem,
  InboxGuideItem,
  InboxItem,
  InboxLearningItem,
  InboxNoteItem,
  InboxReleaseItem,
  InboxTaskItem,
} from '@holtkeeper/api'
import { Check, RefreshCw } from 'lucide-react'
import { useState } from 'react'

import {
  useFamilies,
  useGroupTitles,
  useGuideSection,
  useKnowledgeEntry,
  useLearnings,
  useReleaseRepo,
  useTaskGroup,
} from '../../api/queries.ts'
import { formatDate, formatRelative, isoDay } from '../../lib/format.ts'
import { guideTasks, pendingGenerated, scopeLabel, sectionLabel } from '../../lib/guide.ts'
import { lineDiff, renewalDate } from '../../lib/inbox.ts'
import { kindLabel as knowledgeKindLabel } from '../../lib/knowledge.ts'
import { parseRepoKey } from '../../lib/repo.ts'
import {
  Button,
  ErrorState,
  KeyValue,
  Markdown,
  Placeholder,
  Select,
  Tag,
  TextField,
} from '../../ui/index.ts'
import { BudgetWarningBody } from '../ai/BudgetWarning.tsx'
import { EffectivePrompt } from '../knowledge/EffectivePrompt.tsx'
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
  note: [
    { id: 'note', label: 'Note' },
    { id: 'prompt', label: 'Effective prompt' },
  ],
  learning: [{ id: 'rule', label: 'Rule' }],
  guide: [{ id: 'diff', label: 'Diff' }],
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

function NoteBody({ item, tab }: { item: InboxNoteItem; tab: string }) {
  const entry = useKnowledgeEntry(item.entryId)
  const repos = item.repos.map((repo) => repo.repo)
  const [repo, setRepo] = useState(repos[0])
  const [task, setTask] = useState<GuideTask>('review')
  if (tab === 'prompt') {
    const ref = parseRepoKey(repo)
    if (!repos.length || !ref)
      return (
        <p className="text-sm text-muted">
          This note applies above any one repository; open a repository’s Guide to see its prompt.
        </p>
      )
    return (
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-2">
          <Select
            aria-label="Repository"
            options={repos.map((key) => ({ id: key, label: key }))}
            value={repo}
            onChange={setRepo}
          />
          <Select
            aria-label="Task"
            options={guideTasks}
            value={task}
            onChange={(id) => setTask(guideTasks.find((t) => t.id === id)?.id ?? 'review')}
          />
        </div>
        <EffectivePrompt repo={ref} task={task} />
      </div>
    )
  }
  if (!entry.data) return <Loading error={entry.error} />
  const note = entry.data.entry
  return (
    <div className="flex flex-col gap-4">
      <KeyValue
        rows={[
          { label: 'Kind', value: <Tag>{knowledgeKindLabel(note.kind)}</Tag> },
          { label: 'Applies to', value: item.scope },
          {
            label: 'Topics',
            value: note.topics.length ? note.topics.map((t) => <Tag key={t}>{t}</Tag>) : null,
          },
          { label: 'Version', value: <span className="mono">v{note.version}</span> },
        ]}
      />
      <h3 className="text-[13px] font-semibold">{note.title}</h3>
      <Markdown text={note.body} className="text-[13px]" />
    </div>
  )
}

function LearningBody({ item, decide }: { item: InboxLearningItem; decide: Decide }) {
  const titleOf = useGroupTitles()
  const repo = parseRepoKey(item.repos[0]?.repo)
  const learnings = useLearnings({ ...(repo && { repo }), status: ['proposed'] })
  const families = useFamilies()
  const candidate = learnings.data?.candidates.find((each) => each.id === item.learningId)
  const [chosen, setChosen] = useState<GuideScopeKey>()
  if (!learnings.data) return <Loading error={learnings.error} />
  if (!candidate)
    return <p className="text-sm text-muted">This rule is no longer waiting; someone decided it.</p>
  const suggested =
    candidate.scopes.find((key) => key.startsWith(`${item.suggestedScope}:`)) ?? candidate.scopes[0]
  const scope = chosen ?? suggested
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px]">{candidate.rule}</p>
      <KeyValue
        rows={[
          { label: 'Section', value: <Tag>{sectionLabel(item.section)}</Tag> },
          { label: 'Suggested', value: <Tag tone="info">{item.suggestedScope}</Tag> },
          { label: 'From', value: <span className="mono text-xs">{candidate.repo}</span> },
          { label: 'Why', value: candidate.proposal?.reason },
        ]}
      />
      {candidate.canDecide && candidate.scopes.length ? (
        <div className="flex items-end gap-2">
          <Select
            label="Accept into"
            className="min-w-0 flex-1"
            options={candidate.scopes.map((key) => ({
              id: key,
              label: scopeLabel(key, families.data?.families ?? [], titleOf),
            }))}
            value={scope}
            onChange={(key) => setChosen(candidate.scopes.find((k) => k === key))}
          />
          <Button
            variant="primary"
            size="sm"
            isDisabled={!scope}
            onPress={() => decide(item, 'approve', scope ? { scope } : {})}
          >
            <Check className="size-3.5" />
            Accept
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted">Your grants do not let you accept it into a scope.</p>
      )}
    </div>
  )
}

function DiffView({ before, after }: { before: string; after: string }) {
  const lines = lineDiff(before, after)
  const added = lines.filter((line) => line.kind === 'add').length
  const removed = lines.filter((line) => line.kind === 'del').length
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted">{before ? 'Against the accepted text' : 'First text'}</span>
        <span className="mono text-ok">+{added}</span>
        <span className="mono text-bad">−{removed}</span>
      </div>
      <div
        role="group"
        aria-label="Changes"
        className="mono overflow-x-auto rounded-lg border border-line bg-sunk py-1 text-[11.5px] leading-[1.7]"
      >
        {lines.map((line, index) => (
          <div
            // oxlint-disable-next-line react/no-array-index-key
            key={index}
            className={`whitespace-pre px-2.5 ${line.kind === 'add' ? 'bg-[color-mix(in_oklab,var(--ok)_10%,transparent)]' : line.kind === 'del' ? 'bg-[color-mix(in_oklab,var(--bad)_10%,transparent)]' : ''}`}
          >
            <span aria-hidden className="inline-block w-3.5 text-muted">
              {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
            </span>
            <span className="sr-only">
              {line.kind === 'add' ? 'added: ' : line.kind === 'del' ? 'removed: ' : ''}
            </span>
            {line.text}
          </div>
        ))}
      </div>
    </div>
  )
}

function GuideBody({ item }: { item: InboxGuideItem }) {
  const detail = useGuideSection(item.guideScope, item.section)
  if (!detail.data) return <Loading error={detail.error} />
  const section = detail.data.section
  const pending = pendingGenerated(section)
  if (!pending || pending.inputHash !== item.inputHash)
    return <p className="text-sm text-muted">This text is no longer waiting; it changed since.</p>
  const accepted = section.proposal && section.generated ? section.generated.body : ''
  return (
    <div className="flex flex-col gap-4">
      <KeyValue
        rows={[
          { label: 'Section', value: <Tag>{sectionLabel(item.section)}</Tag> },
          { label: 'Model', value: <span className="mono text-xs">{pending.model}</span> },
          { label: 'Generated', value: formatRelative(pending.generatedAt) },
          {
            label: 'Commit',
            value: pending.sha ? (
              <span className="mono text-xs">{pending.sha.slice(0, 8)}</span>
            ) : null,
          },
          { label: 'Extra prompt', value: pending.prompt },
        ]}
      />
      <DiffView before={accepted} after={pending.body} />
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
    case 'note':
      return <NoteBody item={item} tab={tab} />
    case 'learning':
      return <LearningBody item={item} decide={decide} />
    case 'guide':
      return <GuideBody item={item} />
    case 'release':
      return <ReleaseBody item={item} />
    case 'budget':
      return <BudgetWarningBody item={item} />
    default:
      return <AllowlistBody item={item} decide={decide} />
  }
}
