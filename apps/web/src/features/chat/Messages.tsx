import type { ChatMessageView, ChatParticipantView } from '@holtkeeper/api'
import { ChevronRight, Wrench } from 'lucide-react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useChatTranscript } from '../../api/queries.ts'
import { type MessageGroup, formatCost, toolCalls, toolSummary } from '../../lib/chat.ts'
import { formatDate, formatDateTime } from '../../lib/format.ts'
import { avatarOf } from '../../lib/people.ts'
import { Avatar, BrandIcon, Markdown, Tag } from '../../ui/index.ts'
import { ChatCard } from './ChatCard.tsx'
import { RefChips } from './Refs.tsx'

const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })

function ToolTrace({ message }: { message: ChatMessageView }) {
  const [open, setOpen] = useState(false)
  const transcript = useChatTranscript(message.id, open && message.transcriptRef !== undefined)
  const trace = message.toolTrace ?? []
  const total = trace.reduce((sum, use) => sum + use.calls, 0)
  const calls = transcript.data ? toolCalls(transcript.data.lines) : []
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="inline-flex w-fit items-center gap-1.5 rounded-[7px] px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:bg-raise hover:text-foreground"
      >
        <ChevronRight
          className={`size-3 transition-transform ${open ? 'rotate-90' : ''}`}
          aria-hidden
        />
        <Wrench className="size-3" aria-hidden />
        <span>
          {total} tool {total === 1 ? 'call' : 'calls'}
        </span>
        <span className="mono truncate">{toolSummary(trace)}</span>
      </button>
      {open ? (
        <div className="ml-1.5 border-l border-line pl-3">
          {message.transcriptRef === undefined ? (
            <p className="text-[11px] text-muted">No transcript was kept for this reply.</p>
          ) : transcript.isPending ? (
            <p className="text-[11px] text-muted">Loading the transcript…</p>
          ) : transcript.isError ? (
            <p className="text-[11px] text-muted">{messageOf(transcript.error)}</p>
          ) : calls.length === 0 ? (
            <p className="text-[11px] text-muted">The transcript has no tool calls.</p>
          ) : (
            <ol className="flex flex-col gap-2">
              {calls.map((call) => (
                <li key={call.id} className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <Tag mono tone={call.isError ? 'danger' : 'code'}>
                      {call.name}
                    </Tag>
                    <code className="truncate text-[11px] text-muted" title={call.input}>
                      {call.input}
                    </code>
                  </div>
                  {call.output ? (
                    <pre className="max-h-40 overflow-auto rounded-[7px] border border-line bg-sunk px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap text-muted">
                      {call.output}
                    </pre>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </div>
      ) : null}
    </div>
  )
}

function Body({
  message,
  onRun,
  busy,
}: {
  message: ChatMessageView
  onRun: (command: string) => void
  busy: boolean
}) {
  const command = message.authorType === 'human' && message.body.startsWith('/')
  return (
    <div className="flex flex-col gap-1.5">
      {message.body ? (
        command ? (
          <code className="w-fit rounded-[7px] border border-line bg-raise px-2 py-0.5 font-mono text-[12px]">
            {message.body}
          </code>
        ) : (
          <Markdown
            text={message.body}
            className={`text-[13px] leading-relaxed ${message.authorType === 'system' ? 'text-muted' : ''}`}
          />
        )
      ) : null}
      {message.card ? (
        <ChatCard card={message.card} busy={busy} onRun={onRun} />
      ) : (
        <RefChips refs={message.refs} />
      )}
      {message.authorType === 'agent' && (message.toolTrace?.length || message.costUsd) ? (
        <div className="flex flex-wrap items-center gap-2">
          {message.toolTrace?.length ? <ToolTrace message={message} /> : null}
          {message.costUsd !== undefined ? (
            <span className="mono text-[11px] text-dim" title="Cost of this reply">
              {formatCost(message.costUsd)}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function Author({
  group,
  person,
}: {
  group: MessageGroup
  person: ChatParticipantView | undefined
}) {
  if (group.authorType === 'human')
    return (
      <Avatar
        src={person?.avatarUrl ?? avatarOf(group.authorId ?? '')}
        name={person?.name ?? person?.label ?? ''}
      />
    )
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-full border border-line bg-raise">
      <BrandIcon className="size-5" />
    </span>
  )
}

const authorName = (group: MessageGroup, person: ChatParticipantView | undefined) =>
  group.authorType === 'agent'
    ? 'Holtkeeper'
    : group.authorType === 'system'
      ? 'Holtkeeper · system'
      : (person?.name ?? person?.label ?? 'Someone')

/** A day line between messages of different days. */
function DayLine({ at }: { at: string }) {
  return (
    <div className="flex items-center gap-3 py-1 text-[11px] text-muted">
      <span className="h-px flex-1 bg-line" />
      {formatDate(at)}
      <span className="h-px flex-1 bg-line" />
    </div>
  )
}

/** The line above the first message the viewer had not read when the thread opened. */
function UnreadLine() {
  return (
    <div className="flex items-center gap-3 text-[11px] font-medium text-accent">
      <span className="h-px flex-1 bg-accent/40" />
      New
      <span className="h-px flex-1 bg-accent/40" />
    </div>
  )
}

/**
 * One group of messages under the author's avatar, name and time. People appear by name and
 * avatar; the participant label (all the model ever sees of them) shows on hover.
 */
export function MessageGroupView({
  group,
  people,
  me,
  myHandle,
  unreadId,
  onRun,
  busy,
}: {
  group: MessageGroup
  people: readonly ChatParticipantView[]
  me: string
  /** The viewer's mention handle, to mark messages that mention them. */
  myHandle: string | undefined
  unreadId: string | undefined
  onRun: (command: string) => void
  busy: boolean
}) {
  const person = people.find((participant) => participant.id === group.authorId)
  const first = group.messages[0]
  if (!first) return null
  return (
    <>
      {group.day ? <DayLine at={first.createdAt} /> : null}
      {group.messages.map((message, index) => {
        const mentionsMe =
          myHandle !== undefined && message.authorId !== me && message.mentions.includes(myHandle)
        return (
          <div key={message.id} className="flex flex-col gap-3">
            {message.id === unreadId ? <UnreadLine /> : null}
            <article
              className={`group/message flex gap-3 rounded-[10px] px-2 py-1 transition-colors ${
                mentionsMe ? 'bg-accent-soft shadow-[inset_2px_0_0_var(--brand)]' : 'hover:bg-panel'
              }`}
            >
              <div className="w-8 shrink-0">
                {index === 0 || message.id === unreadId ? (
                  <Author group={group} person={person} />
                ) : (
                  <time
                    dateTime={message.createdAt}
                    className="mono hidden pt-0.5 text-[10px] text-dim group-hover/message:block"
                  >
                    {clock.format(new Date(message.createdAt))}
                  </time>
                )}
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                {index === 0 || message.id === unreadId ? (
                  <header className="flex items-baseline gap-2">
                    <span
                      className="text-[13px] font-semibold"
                      title={person ? `${person.label} to Holtkeeper` : undefined}
                    >
                      {authorName(group, person)}
                    </span>
                    {group.authorType === 'agent' ? (
                      <Tag tone="accent" className="text-[10px]">
                        AI
                      </Tag>
                    ) : null}
                    <time
                      dateTime={message.createdAt}
                      title={formatDateTime(message.createdAt)}
                      className="mono text-[11px] text-dim"
                    >
                      {clock.format(new Date(message.createdAt))}
                    </time>
                  </header>
                ) : null}
                <Body message={message} onRun={onRun} busy={busy} />
              </div>
            </article>
          </div>
        )
      })}
    </>
  )
}
