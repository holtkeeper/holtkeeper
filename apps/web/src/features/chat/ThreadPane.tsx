import type { ChatCommandView, ChatMessageRef, ChatThreadView } from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import {
  Archive,
  ArchiveRestore,
  Bell,
  BellOff,
  Download,
  FolderGit2,
  Pencil,
  Plus,
  Users,
  X,
} from 'lucide-react'
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { api } from '../../api/endpoints.ts'
import {
  useChatContext,
  useChatMutations,
  useChatPeople,
  useChatThread,
  useRepos,
} from '../../api/queries.ts'
import {
  addableRepos,
  firstUnreadId,
  formatCost,
  groupMessages,
  threadKind,
  threadRefs,
  threadScope,
  toolSummary,
} from '../../lib/chat.ts'
import { plural, shortId } from '../../lib/format.ts'
import { repoKey } from '../../lib/repo.ts'
import {
  Avatar,
  Button,
  ErrorState,
  MoreMenu,
  type MoreMenuItem,
  Placeholder,
  Select,
  Switch,
  Tag,
  Tooltip,
  notify,
} from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'
import { Composer } from './Composer.tsx'
import { MessageGroupView } from './Messages.tsx'
import { RefChips } from './Refs.tsx'

function Title({ thread }: { thread: ChatThreadView }) {
  const { update } = useChatMutations()
  const [editing, setEditing] = useState<string>()
  if (editing !== undefined)
    return (
      <form
        className="min-w-0 flex-1"
        onSubmit={(event) => {
          event.preventDefault()
          const title = editing.trim()
          if (title && title !== thread.title) update.mutate({ id: thread.id, title })
          setEditing(undefined)
        }}
      >
        <input
          aria-label="Thread title"
          value={editing}
          maxLength={120}
          onChange={(event) => setEditing(event.target.value)}
          onBlur={(event) => event.currentTarget.form?.requestSubmit()}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setEditing(undefined)
          }}
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- the field replaces the title the user clicked
          autoFocus
          className="h-7 w-full rounded-[7px] border border-line-strong bg-raise px-2 text-[14px] font-semibold outline-none"
        />
      </form>
    )
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      <h2 className="truncate text-[14px] font-semibold">{thread.title}</h2>
      {thread.archived ? null : (
        <Button
          size="sm"
          variant="ghost"
          isIconOnly
          aria-label="Rename thread"
          onPress={() => setEditing(thread.title)}
        >
          <Pencil className="size-3" aria-hidden />
        </Button>
      )}
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
      <h3 className="flex items-baseline justify-between gap-2 text-[11px] font-medium tracking-wide text-muted uppercase">
        {title}
        {aside ? (
          <span className="mono text-[11px] tracking-normal normal-case">{aside}</span>
        ) : null}
      </h3>
      {children}
    </section>
  )
}

function ContextRepos({ thread, hidden }: { thread: ChatThreadView; hidden: number }) {
  const { update } = useChatMutations()
  const [adding, setAdding] = useState(false)
  const repos = useRepos(adding)
  const save = (contextRepos: string[]) =>
    update.mutate(
      { id: thread.id, contextRepos },
      { onError: (error) => notify.error('Context not saved', messageOf(error)) },
    )
  const options = addableRepos(
    (repos.data?.repos ?? []).map((entry) => repoKey(entry.repo)),
    thread.contextRepos,
  )
  return (
    <Section title="Context" aside={thread.contextRepos.length || undefined}>
      {thread.contextRepos.length ? (
        <ul className="flex flex-col gap-1">
          {thread.contextRepos.map((repo) => (
            <li key={repo} className="flex items-center gap-1.5 text-[12.5px]">
              <FolderGit2 aria-hidden className="size-3.5 shrink-0 text-muted" />
              <span className="mono min-w-0 flex-1 truncate">{threadScope({ repo })}</span>
              {thread.archived ? null : (
                <Button
                  size="sm"
                  variant="ghost"
                  isIconOnly
                  aria-label={`Remove ${repo} from the context`}
                  isDisabled={update.isPending}
                  onPress={() => save(thread.contextRepos.filter((each) => each !== repo))}
                >
                  <X className="size-3" aria-hidden />
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12px] text-muted">No repositories attached.</p>
      )}
      {hidden > 0 ? (
        <p className="text-[11px] text-dim">
          {plural(hidden, 'more repository', 'more repositories')} you cannot read.
        </p>
      ) : null}
      {thread.archived ? null : adding ? (
        <Select
          aria-label="Repository to add"
          placeholder={repos.isPending ? 'Loading repositories…' : 'Pick a repository'}
          value={undefined}
          isDisabled={repos.isPending}
          onChange={(repo) => {
            setAdding(false)
            save([...thread.contextRepos, repo])
          }}
          options={options.map((repo) => ({
            id: repo,
            label: <span className="mono">{threadScope({ repo })}</span>,
            text: repo,
          }))}
        />
      ) : (
        <Button size="sm" variant="ghost" className="self-start" onPress={() => setAdding(true)}>
          <Plus className="size-3.5" aria-hidden /> Add repo
        </Button>
      )}
      <p className="text-[11px] text-dim">
        Holtkeeper reads these repositories when it answers, only where the person asking may read
        them.
      </p>
    </Section>
  )
}

function Context({ thread, refs }: { thread: ChatThreadView; refs: readonly ChatMessageRef[] }) {
  const { update } = useChatMutations()
  const context = useChatContext(thread.id)
  const data = context.data
  const counts = new Map((data?.participants ?? []).map((person) => [person.id, person.messages]))
  const mentioned = (data?.repos ?? []).filter(
    (repo) => repo !== thread.repo && !thread.contextRepos.includes(repo),
  )
  return (
    <aside className="hidden w-64 shrink-0 flex-col gap-5 overflow-y-auto border-l border-line p-4 xl:flex">
      <Section title="Thread" aside={shortId(thread.id)}>
        <span className="flex items-center gap-1.5 text-[13px]">
          {thread.repo ? (
            <FolderGit2 className="size-3.5 text-muted" aria-hidden />
          ) : (
            <Users className="size-3.5 text-muted" aria-hidden />
          )}
          <span className="mono truncate">{threadScope(thread)}</span>
        </span>
        <p className="text-[12px] text-muted">
          {threadKind(thread)} · {plural(data?.messageCount ?? thread.messageCount, 'message')}
          {thread.muted ? ' · muted' : ''}
        </p>
        {thread.groups.length ? (
          <div className="flex flex-wrap gap-1">
            {thread.groups.map((group) => (
              <Tag key={group}>{group}</Tag>
            ))}
          </div>
        ) : null}
      </Section>
      <ContextRepos thread={thread} hidden={data?.hiddenRepoCount ?? 0} />
      {mentioned.length ? (
        <Section title="Mentioned" aside={mentioned.length}>
          <RefChips refs={mentioned.map((repo) => ({ kind: 'repo' as const, repo }))} />
        </Section>
      ) : null}
      <Section title="Agent">
        <Switch
          label="Reply to every message"
          isSelected={thread.autoReply}
          isDisabled={thread.archived}
          onChange={(autoReply) => update.mutate({ id: thread.id, autoReply })}
        />
        <p className="text-[11px] text-dim">
          {thread.autoReply
            ? 'Holtkeeper answers every message here.'
            : 'Off: Holtkeeper replies only when someone mentions @holtkeeper.'}
          {thread.summarized ? ' Older messages reach the agent as a summary.' : ''}
        </p>
        {data?.tools.length ? (
          <p className="mono text-[11px] text-muted" title="Tool calls over every reply">
            {toolSummary(data.tools)}
          </p>
        ) : null}
      </Section>
      <Section title="Participants" aside={thread.participants.length}>
        <ul className="flex flex-col gap-1.5">
          {thread.participants.map((person) => (
            <li key={person.id} className="flex items-center gap-2 text-[13px]">
              <Avatar src={person.avatarUrl} name={person.name ?? person.label} size="xs" />
              <span className="min-w-0 flex-1 truncate">{person.name ?? person.label}</span>
              <Tooltip content={`${person.label}: all Holtkeeper knows of this person`}>
                <span className="mono shrink-0 text-[10px] text-dim">
                  {counts.get(person.id) ?? 0} · {person.label.replace('Participant ', '')}
                </span>
              </Tooltip>
            </li>
          ))}
        </ul>
        <p className="text-[11px] text-dim">
          Holtkeeper refers to people by these labels and removes the names and emails it knows.
        </p>
      </Section>
      {refs.length ? (
        <Section title="Cited and linked" aside={refs.length}>
          <RefChips refs={refs} />
        </Section>
      ) : null}
      {data?.costUsd !== undefined ? (
        <Section title="Agent cost">
          <div className="flex items-baseline justify-between text-[12px]">
            <span className="text-muted">Thread total</span>
            <span className="mono">{formatCost(data.costUsd)}</span>
          </div>
          <Link to="/ops/spend" className="text-[12px] text-muted hover:text-foreground">
            Open AI spend
          </Link>
        </Section>
      ) : null}
    </aside>
  )
}

/** Mute, Export and Archive of the open thread, in its "⋯" menu. */
function threadMenu(
  thread: ChatThreadView,
  update: (input: { muted?: boolean; archived?: boolean }) => void,
): MoreMenuItem[] {
  return [
    {
      label: thread.muted ? 'Unmute thread' : 'Mute thread',
      icon: thread.muted ? Bell : BellOff,
      onAction: () => update({ muted: !thread.muted }),
    },
    {
      label: 'Export as Markdown',
      icon: Download,
      onAction: () => download(api.chatExportUrl(thread.id)),
    },
    {
      label: thread.archived ? 'Restore thread' : 'Archive thread',
      icon: thread.archived ? ArchiveRestore : Archive,
      onAction: () => update({ archived: !thread.archived }),
    },
  ]
}

function download(url: string) {
  const link = document.createElement('a')
  link.href = url
  link.rel = 'noopener'
  link.click()
}

/** The open thread: header, messages with day and unread lines, the composer and its context. */
export function ThreadPane({
  threadId,
  commands,
}: {
  threadId: string
  commands: readonly ChatCommandView[]
}) {
  const { principal } = useSession()
  const { messages, loadOlder } = useChatThread(threadId)
  const people = useChatPeople(threadId)
  const { post, update, read } = useChatMutations()
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const keepFrom = useRef<number>(undefined)
  const [unreadId, setUnreadId] = useState<string>()
  const opened = useRef(false)

  const data = messages.data
  const thread = data?.thread
  const list = useMemo(() => data?.messages ?? [], [data])
  const groups = useMemo(() => groupMessages(list), [list])
  const last = list.at(-1)
  const refs = useMemo(() => threadRefs(list), [list])
  const myHandle = people.data?.people.find((person) => person.id === principal.id)?.handle

  useEffect(() => {
    if (!data || opened.current) return
    opened.current = true
    setUnreadId(firstUnreadId(data.messages, data.thread.unread, principal.id))
  }, [data, principal.id])

  useEffect(() => {
    const markRead = () => {
      if (last && thread && thread.unread > 0 && document.visibilityState === 'visible')
        read.mutate({ id: threadId, messageId: last.id })
    }
    markRead()
    document.addEventListener('visibilitychange', markRead)
    return () => document.removeEventListener('visibilitychange', markRead)
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- moves the marker when a new message arrives or the tab shows
  }, [last?.id, thread?.unread, threadId])

  useLayoutEffect(() => {
    const element = scroller.current
    if (!element) return
    if (keepFrom.current !== undefined) {
      element.scrollTop = element.scrollHeight - keepFrom.current
      keepFrom.current = undefined
    } else if (stick.current) element.scrollTop = element.scrollHeight
  }, [list, thread?.replying])

  const send = (body: string) => {
    stick.current = true
    post.mutate(
      { id: threadId, body },
      { onError: (error) => notify.error('Not sent', messageOf(error)) },
    )
  }

  const older = () => {
    const element = scroller.current
    if (element) keepFrom.current = element.scrollHeight - element.scrollTop
    loadOlder.mutate()
  }

  if (messages.isPending) return <Placeholder className="m-4 h-64 flex-1" />
  if (messages.isError || !thread) return <ErrorState error={messages.error} />
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
          <Title key={thread.id} thread={thread} />
          <Tag mono>{threadScope(thread)}</Tag>
          {thread.autoReply ? <Tag tone="accent">Auto reply</Tag> : null}
          {thread.muted ? (
            <Tag>
              <BellOff aria-hidden className="size-3" /> Muted
            </Tag>
          ) : null}
          <MoreMenu
            aria-label="Thread actions"
            items={threadMenu(thread, (input) =>
              update.mutate(
                { id: threadId, ...input },
                { onError: (error) => notify.error('Not changed', messageOf(error)) },
              ),
            )}
          />
        </header>
        <div
          ref={scroller}
          onScroll={(event) => {
            const element = event.currentTarget
            stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48
          }}
          className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
          aria-live="polite"
        >
          <div className="mx-auto flex max-w-3xl flex-col gap-3">
            {data.hasMore ? (
              <Button
                size="sm"
                variant="ghost"
                className="self-center"
                isDisabled={loadOlder.isPending}
                onPress={older}
              >
                Load older messages
              </Button>
            ) : null}
            {list.length === 0 ? (
              <div className="py-16 text-center text-[13px] text-muted">
                <p>Nothing here yet.</p>
                <p className="mt-1 text-xs">
                  Mention <span className="mono text-foreground">@holtkeeper</span> to ask the
                  agent, or type <span className="mono text-foreground">/</span> for commands.
                </p>
              </div>
            ) : (
              groups.map((group) => (
                <MessageGroupView
                  key={group.key}
                  group={group}
                  people={thread.participants}
                  me={principal.id}
                  myHandle={myHandle}
                  unreadId={unreadId}
                  busy={post.isPending}
                  onRun={(command) => send(`/${command}`)}
                />
              ))
            )}
            {thread.replying ? (
              <div className="flex items-center gap-2 px-2 text-[12px] text-muted">
                <span className="flex gap-0.5">
                  <span className="size-1.5 animate-pulse rounded-full bg-accent" />
                  <span className="size-1.5 animate-pulse rounded-full bg-accent [animation-delay:150ms]" />
                  <span className="size-1.5 animate-pulse rounded-full bg-accent [animation-delay:300ms]" />
                </span>
                Holtkeeper is writing a reply
              </div>
            ) : null}
          </div>
        </div>
        <div className="shrink-0 border-t border-line px-4 py-3">
          <div className="mx-auto max-w-3xl">
            {thread.archived ? (
              <p className="text-center text-[12px] text-muted">
                This thread is archived. Restore it to write again.
              </p>
            ) : (
              <Composer
                key={thread.id}
                people={people.data?.people ?? []}
                commands={commands}
                autoReply={thread.autoReply}
                scope={thread.repo || thread.group ? threadScope(thread) : undefined}
                busy={post.isPending}
                onSend={send}
              />
            )}
          </div>
        </div>
      </section>
      <Context thread={thread} refs={refs} />
    </div>
  )
}
