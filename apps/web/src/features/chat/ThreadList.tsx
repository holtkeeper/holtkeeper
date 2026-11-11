import type { ChatThreadView } from '@holtkeeper/api'
import { Archive, Bot, FolderGit2, Plus, Users } from 'lucide-react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useChatMutations, useRepos } from '../../api/queries.ts'
import { threadScope, unreadBadge } from '../../lib/chat.ts'
import { formatRelative } from '../../lib/format.ts'
import type { ScopeView } from '../../lib/home-scope.ts'
import { repoKey } from '../../lib/repo.ts'
import {
  Button,
  Dialog,
  ErrorState,
  Placeholder,
  ScopeSwitch,
  Segmented,
  Select,
  Switch,
  TextField,
  Tooltip,
  notify,
} from '../../ui/index.ts'

type ScopeKind = 'team' | 'repo' | 'group'

function NewThreadDialog({
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
  const repos = useRepos(isOpen)
  const { create } = useChatMutations()
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState<ScopeKind>('team')
  const [repo, setRepo] = useState<string>()
  const [group, setGroup] = useState<string>()
  const [autoReply, setAutoReply] = useState(false)
  const target = kind === 'repo' ? repo : kind === 'group' ? group : 'team'
  const ready = title.trim() !== '' && target !== undefined && !create.isPending

  const submit = () => {
    if (!ready) return
    create.mutate(
      {
        title: title.trim(),
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
        <TextField label="Title" value={title} onChange={setTitle} autoFocus />
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
            options={groups.map((id) => ({ id, label: id }))}
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
  const badge = unreadBadge(thread.unread)
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
          <span className={`block truncate text-[13px] ${badge ? 'font-semibold' : 'font-medium'}`}>
            {thread.title}
          </span>
          <span className="mt-0.5 flex items-center gap-1 text-[11px] text-muted">
            <ScopeIcon thread={thread} />
            <span className="mono truncate">{threadScope(thread)}</span>
            <span aria-hidden>·</span>
            <span className="shrink-0">{formatRelative(thread.updatedAt)}</span>
          </span>
        </span>
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

/** The left column of the chat: scope switch, archive toggle, new thread and the threads. */
export function ThreadList({
  threads,
  counts,
  view,
  onView,
  archived,
  onArchived,
  groups,
  selected,
  onSelect,
  isPending,
  error,
}: {
  threads: readonly ChatThreadView[]
  counts: Record<ScopeView, number> | undefined
  view: ScopeView
  onView: (view: ScopeView) => void
  archived: boolean
  onArchived: (archived: boolean) => void
  groups: readonly string[]
  selected: string | undefined
  onSelect: (id: string) => void
  isPending: boolean
  error: unknown
}) {
  const [creating, setCreating] = useState(false)
  return (
    <aside className="flex max-h-72 min-h-0 w-full shrink-0 flex-col border-b border-line md:max-h-none md:w-72 md:border-r md:border-b-0">
      <div className="flex flex-col gap-2 border-b border-line p-3">
        <div className="flex items-center gap-2">
          <h2 className="flex-1 text-[13px] font-semibold">Threads</h2>
          <Tooltip content={archived ? 'Show open threads' : 'Show archived threads'}>
            <Button
              size="sm"
              variant={archived ? 'secondary' : 'ghost'}
              isIconOnly
              aria-label={archived ? 'Show open threads' : 'Show archived threads'}
              onPress={() => onArchived(!archived)}
            >
              <Archive className="size-3.5" aria-hidden />
            </Button>
          </Tooltip>
          <Button size="sm" variant="primary" onPress={() => setCreating(true)}>
            <Plus className="size-3.5" aria-hidden /> New
          </Button>
        </div>
        <ScopeSwitch value={view} onChange={onView} {...(counts && { counts })} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {isPending ? (
          <Placeholder className="h-32" />
        ) : error ? (
          <ErrorState error={error} />
        ) : threads.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted">
            {archived ? 'No archived threads.' : 'No threads in this scope yet.'}
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {threads.map((thread) => (
              <ThreadRow
                key={thread.id}
                thread={thread}
                selected={thread.id === selected}
                onSelect={() => onSelect(thread.id)}
              />
            ))}
          </ul>
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
