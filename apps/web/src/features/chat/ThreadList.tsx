import type { ChatThreadView } from '@holtkeeper/api'
import { Archive, BellOff, Bot, FolderGit2, Plus, Users } from 'lucide-react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useChatMutations, useGroupTitles, useRepos } from '../../api/queries.ts'
import { isNaming, newThreadTitle, threadBadge, threadScope } from '../../lib/chat.ts'
import { formatRelative } from '../../lib/format.ts'
import type { ScopeCounts, ScopeView } from '../../lib/home-scope.ts'
import { repoKey } from '../../lib/repo.ts'
import {
  Button,
  Dialog,
  ErrorState,
  OtherTeams,
  Placeholder,
  NoTeamsState,
  ScopeSwitch,
  SearchInput,
  Segmented,
  Select,
  Switch,
  TextField,
  Tooltip,
  notify,
} from '../../ui/index.ts'

type ScopeKind = 'team' | 'repo' | 'group'

/** Creates a chat thread; `onCreated` gets the new thread's id after the dialog closes. */
export function NewThreadDialog({
  isOpen,
  onOpenChange,
  groups,
  onCreated,
}: {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  groups: readonly string[]
  onCreated: (id: string) => void
}) {
  const titleOf = useGroupTitles()
  const repos = useRepos(isOpen)
  const { create } = useChatMutations()
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState<ScopeKind>('team')
  const [repo, setRepo] = useState<string>()
  const [group, setGroup] = useState<string>()
  const [autoReply, setAutoReply] = useState(false)
  const target = kind === 'repo' ? repo : kind === 'group' ? group : 'team'
  const ready = target !== undefined && !create.isPending

  const submit = () => {
    if (!ready) return
    create.mutate(
      {
        ...newThreadTitle(title),
        autoReply,
        ...(kind === 'repo' && repo && { repo }),
        ...(kind === 'group' && group && { group }),
      },
      {
        onSuccess: (thread) => {
          setTitle('')
          onOpenChange(false)
          onCreated(thread.id)
        },
        onError: (error) => notify.error('Not created', messageOf(error)),
      },
    )
  }

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title="New thread"
      description="Everyone who can read its scope sees the thread."
      footer={
        <Button variant="primary" isDisabled={!ready} onPress={submit}>
          Create
        </Button>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <TextField
          label="Title"
          placeholder="Optional — named from the first message"
          value={title}
          onChange={setTitle}
          autoFocus
        />
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">About</span>
          <Segmented<ScopeKind>
            aria-label="Thread scope"
            value={kind}
            onChange={setKind}
            options={[
              { id: 'team', label: 'Whole team' },
              { id: 'repo', label: 'Repository' },
              ...(groups.length ? [{ id: 'group' as const, label: 'Group' }] : []),
            ]}
          />
        </div>
        {kind === 'repo' ? (
          <Select
            aria-label="Repository"
            placeholder="Pick a repository"
            value={repo}
            onChange={setRepo}
            options={(repos.data?.repos ?? []).map((entry) => ({
              id: repoKey(entry.repo),
              label: <span className="mono">{entry.repo.path}</span>,
              text: entry.repo.path,
            }))}
          />
        ) : null}
        {kind === 'group' ? (
          <Select
            aria-label="Group"
            placeholder="Pick a group"
            value={group}
            onChange={setGroup}
            options={groups.map((id) => ({ id, label: titleOf(id) }))}
          />
        ) : null}
        <Switch
          label="Holtkeeper replies to every message"
          description="Otherwise only when someone mentions @holtkeeper."
          isSelected={autoReply}
          onChange={setAutoReply}
        />
      </form>
    </Dialog>
  )
}

function ScopeIcon({ thread }: { thread: ChatThreadView }) {
  const Icon = thread.repo ? FolderGit2 : thread.group ? Users : Bot
  return <Icon className="size-3 shrink-0" aria-hidden />
}

function ThreadRow({
  thread,
  selected,
  onSelect,
}: {
  thread: ChatThreadView
  selected: boolean
  onSelect: () => void
}) {
  const badge = threadBadge(thread)
  const titleOf = useGroupTitles()
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className={`flex w-full items-start gap-2 rounded-[7px] px-2.5 py-2 text-left transition-colors ${
          selected ? 'bg-raise shadow-[inset_0_0_0_1px_var(--line)]' : 'hover:bg-raise/60'
        }`}
      >
        <span className="min-w-0 flex-1">
          {isNaming(thread) ? (
            <span className="block truncate text-[13px] text-muted italic">Naming…</span>
          ) : (
            <span
              className={`block truncate text-[13px] ${badge ? 'font-semibold' : 'font-medium'} ${thread.titlePending ? 'text-muted' : ''}`}
            >
              {thread.title}
            </span>
          )}
          <span className="mt-0.5 flex items-center gap-1 text-[11px] text-muted">
            <ScopeIcon thread={thread} />
            <span className="mono truncate">{threadScope(thread, titleOf)}</span>
            <span aria-hidden>·</span>
            <span className="shrink-0">{formatRelative(thread.updatedAt)}</span>
          </span>
        </span>
        {thread.muted ? (
          <Tooltip content="Muted: never counts as unread">
            <BellOff aria-label="Muted" className="mt-1 size-3 shrink-0 text-dim" />
          </Tooltip>
        ) : null}
        {thread.replying ? (
          <Tooltip content="Holtkeeper is writing">
            <span aria-label="Holtkeeper is writing" className="mt-1.5 flex gap-0.5">
              <span className="size-1 animate-pulse rounded-full bg-accent" />
              <span className="size-1 animate-pulse rounded-full bg-accent [animation-delay:150ms]" />
              <span className="size-1 animate-pulse rounded-full bg-accent [animation-delay:300ms]" />
            </span>
          </Tooltip>
        ) : null}
        {badge ? (
          <span
            aria-label={`${thread.unread} unread`}
            className="mono mt-0.5 min-w-5 rounded-full bg-accent px-1.5 text-center text-[11px] leading-[18px] font-semibold text-accent-foreground"
          >
            {badge}
          </span>
        ) : null}
      </button>
    </li>
  )
}

const threadNoun = { one: 'thread' }

/**
 * The left column of the chat: title search, scope switch, archive toggle with the archived count,
 * new thread, the threads and other teams' threads folded under them.
 */
export function ThreadList({
  threads,
  others,
  otherTeams,
  counts,
  view,
  onView,
  noTeams = false,
  query,
  onQuery,
  archived,
  onArchived,
  archivedCount,
  groups,
  selected,
  onSelect,
  isPending,
  error,
}: {
  threads: readonly ChatThreadView[]
  others: readonly ChatThreadView[]
  otherTeams: readonly string[]
  counts: ScopeCounts | undefined
  view: ScopeView
  onView: (view: ScopeView) => void
  /** *My teams* without home groups: the empty list links to choosing them. */
  noTeams?: boolean
  query: string
  onQuery: (query: string) => void
  archived: boolean
  onArchived: (archived: boolean) => void
  archivedCount: number
  groups: readonly string[]
  selected: string | undefined
  onSelect: (id: string) => void
  isPending: boolean
  error: unknown
}) {
  const [creating, setCreating] = useState(false)
  const row = (thread: ChatThreadView) => (
    <ThreadRow
      key={thread.id}
      thread={thread}
      selected={thread.id === selected}
      onSelect={() => onSelect(thread.id)}
    />
  )
  const archiveLabel = archived ? 'Show open threads' : `Show ${archivedCount} archived threads`
  return (
    <aside className="flex max-h-72 min-h-0 w-full shrink-0 flex-col border-b border-line md:max-h-none md:w-72 md:border-r md:border-b-0">
      <div className="flex flex-col gap-2 border-b border-line p-3">
        <div className="flex items-center gap-2">
          <h2 className="flex-1 text-[13px] font-semibold">{archived ? 'Archived' : 'Threads'}</h2>
          <Tooltip content={archiveLabel}>
            <Button
              size="sm"
              variant={archived ? 'secondary' : 'ghost'}
              aria-label={archiveLabel}
              onPress={() => onArchived(!archived)}
            >
              <Archive className="size-3.5" aria-hidden />
              <span className="mono text-[11px]">{archivedCount}</span>
            </Button>
          </Tooltip>
          <Button size="sm" variant="primary" onPress={() => setCreating(true)}>
            <Plus className="size-3.5" aria-hidden /> New
          </Button>
        </div>
        <SearchInput value={query} onChange={onQuery} aria-label="Search thread titles" />
        <ScopeSwitch value={view} onChange={onView} {...(counts && { counts })} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {isPending ? (
          <Placeholder className="h-32" />
        ) : error ? (
          <ErrorState error={error} />
        ) : threads.length === 0 && others.length === 0 && noTeams && !query.trim() ? (
          <NoTeamsState />
        ) : threads.length === 0 && others.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted">
            {query.trim()
              ? 'No thread title matches.'
              : archived
                ? 'No archived threads.'
                : 'No threads in this scope yet.'}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {threads.length ? <ul className="flex flex-col gap-0.5">{threads.map(row)}</ul> : null}
            <OtherTeams count={others.length} teams={otherTeams} noun={threadNoun}>
              <ul className="flex flex-col gap-0.5">{others.map(row)}</ul>
            </OtherTeams>
          </div>
        )}
      </div>
      <NewThreadDialog
        isOpen={creating}
        onOpenChange={setCreating}
        groups={groups}
        onCreated={onSelect}
      />
    </aside>
  )
}
