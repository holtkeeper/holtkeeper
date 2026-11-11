import type { ChatCommandView, ChatThreadView } from '@holtkeeper/api'
import { Archive, ArchiveRestore, FolderGit2, Pencil, Users } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useChatMutations, useChatPeople, useChatThread } from '../../api/queries.ts'
import { firstUnreadId, formatCost, groupMessages, threadScope } from '../../lib/chat.ts'
import {
  Avatar,
  Button,
  ErrorState,
  Placeholder,
  Switch,
  Tag,
  Tooltip,
  notify,
} from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'
import { Composer } from './Composer.tsx'
import { MessageGroupView } from './Messages.tsx'

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

function Context({ thread, spend }: { thread: ChatThreadView; spend: number }) {
  const { update } = useChatMutations()
  return (
    <aside className="hidden w-60 shrink-0 flex-col gap-5 overflow-y-auto border-l border-line p-4 xl:flex">
      <section className="flex flex-col gap-1.5">
        <h3 className="text-[11px] font-medium tracking-wide text-muted uppercase">About</h3>
        <span className="flex items-center gap-1.5 text-[13px]">
          {thread.repo ? (
            <FolderGit2 className="size-3.5 text-muted" aria-hidden />
          ) : (
            <Users className="size-3.5 text-muted" aria-hidden />
          )}
          <span className="mono truncate">{threadScope(thread)}</span>
        </span>
        {thread.groups.length ? (
          <div className="flex flex-wrap gap-1">
            {thread.groups.map((group) => (
              <Tag key={group}>{group}</Tag>
            ))}
          </div>
        ) : null}
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="text-[11px] font-medium tracking-wide text-muted uppercase">Participants</h3>
        <ul className="flex flex-col gap-1.5">
          {thread.participants.map((person) => (
            <li key={person.id} className="flex items-center gap-2 text-[13px]">
              <Avatar src={person.avatarUrl} name={person.name ?? person.label} size="xs" />
              <span className="truncate">{person.name ?? person.label}</span>
              <Tooltip content="All Holtkeeper knows of this person">
                <span className="ml-auto shrink-0 text-[10px] text-dim">
                  {person.label.replace('Participant ', '')}
                </span>
              </Tooltip>
            </li>
          ))}
        </ul>
        <p className="text-[11px] text-dim">
          Holtkeeper refers to people by these labels and removes the names and emails it knows.
        </p>
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="text-[11px] font-medium tracking-wide text-muted uppercase">Agent</h3>
        <Switch
          label="Reply to every message"
          isSelected={thread.autoReply}
          isDisabled={thread.archived}
          onChange={(autoReply) => update.mutate({ id: thread.id, autoReply })}
        />
        <div className="flex items-baseline justify-between text-[12px]">
          <span className="text-muted">Agent spend, loaded replies</span>
          <span className="mono">{formatCost(spend)}</span>
        </div>
        {thread.summarized ? (
          <p className="text-[11px] text-dim">Older messages reach the agent as a summary.</p>
        ) : null}
      </section>
    </aside>
  )
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
  const spend = list.reduce((sum, message) => sum + (message.costUsd ?? 0), 0)
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
          <Button
            size="sm"
            variant="ghost"
            onPress={() => update.mutate({ id: threadId, archived: !thread.archived })}
          >
            {thread.archived ? (
              <ArchiveRestore className="size-3.5" aria-hidden />
            ) : (
              <Archive className="size-3.5" aria-hidden />
            )}
            {thread.archived ? 'Restore' : 'Archive'}
          </Button>
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
      <Context thread={thread} spend={spend} />
    </div>
  )
}
