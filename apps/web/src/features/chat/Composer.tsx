import type { ChatCommandView, ChatPersonView } from '@holtkeeper/api'
import { ArrowUp, SquareSlash } from 'lucide-react'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'

import {
  type MentionOption,
  asksAgent,
  insertMention,
  matchingCommands,
  mentionAt,
  mentionOptions,
} from '../../lib/chat.ts'
import { isEditableTarget } from '../../lib/slash-focus.ts'
import { Avatar, BrandIcon, Button, Kbd } from '../../ui/index.ts'

type Suggestion =
  | { kind: 'mention'; option: MentionOption }
  | { kind: 'command'; command: ChatCommandView }

const suggestionKey = (item: Suggestion) =>
  item.kind === 'mention' ? `@${item.option.handle}` : `/${item.command.name}`

function SuggestionRow({ item }: { item: Suggestion }) {
  if (item.kind === 'command')
    return (
      <>
        <span className="mono text-[12px]">/{item.command.name}</span>
        {item.command.usage ? (
          <span className="mono truncate text-[11px] text-dim">{item.command.usage}</span>
        ) : null}
        <span className="ml-auto truncate pl-3 text-[11px] text-muted">{item.command.summary}</span>
      </>
    )
  const { option } = item
  return (
    <>
      {option.agent ? (
        <span className="grid size-5 shrink-0 place-items-center rounded-full border border-line bg-raise">
          <BrandIcon className="size-3.5" />
        </span>
      ) : (
        <Avatar src={option.avatarUrl ?? ''} name={option.name} size="xs" />
      )}
      <span className="text-[13px]">{option.name}</span>
      <span className="mono truncate text-[11px] text-dim">@{option.handle}</span>
      {option.agent ? (
        <span className="ml-auto pl-3 text-[11px] text-muted">asks for a reply</span>
      ) : null}
    </>
  )
}

/**
 * The thread's composer. `@` opens a list of the people who can see the thread (and Holtkeeper);
 * a leading `/` switches to command mode with the commands as hints, or, in a team-wide thread
 * (no `scope`), to a note that commands run in repository and group threads. Enter sends, Shift+Enter
 * starts a new line, arrows and Tab pick from a list.
 */
export function Composer({
  people,
  commands,
  autoReply,
  scope,
  busy,
  onSend,
}: {
  people: readonly ChatPersonView[]
  commands: readonly ChatCommandView[]
  autoReply: boolean
  /** What commands run about, shown in command mode; absent in team-wide threads, which refuse commands. */
  scope?: string | undefined
  busy: boolean
  onSend: (body: string) => void
}) {
  const [text, setText] = useState('')
  const [caret, setCaret] = useState(0)
  const [active, setActive] = useState(0)
  const [dismissed, setDismissed] = useState<string>()
  const input = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const touch = globalThis.matchMedia?.('(pointer: coarse)').matches ?? false
    if (!touch && !isEditableTarget(document.activeElement))
      input.current?.focus({ preventScroll: true })
  }, [])

  const commandMode = text.startsWith('/')
  const mention = commandMode ? undefined : mentionAt(text, caret)
  const refused = commandMode && scope === undefined
  const suggestions: Suggestion[] = commandMode
    ? refused
      ? []
      : matchingCommands(commands, text.slice(1)).map((command) => ({ kind: 'command', command }))
    : mention
      ? mentionOptions(people, mention.query).map((option) => ({ kind: 'mention', option }))
      : []
  const listKey = commandMode ? 'command' : mention ? `mention:${mention.start}` : undefined
  const shown = listKey !== undefined && listKey !== dismissed ? suggestions : []
  const selected = Math.min(active, Math.max(shown.length - 1, 0))
  const agentWillReply = asksAgent(text, autoReply)

  const update = (next: string, at: number) => {
    setText(next)
    setCaret(at)
    setActive(0)
  }

  const pick = (item: Suggestion) => {
    if (item.kind === 'command') {
      const next = `/${item.command.name} `
      update(next, next.length)
    } else if (mention) {
      const next = insertMention(text, mention.start, caret, item.option.handle)
      update(next.text, next.caret)
      requestAnimationFrame(() => input.current?.setSelectionRange(next.caret, next.caret))
    }
    input.current?.focus()
  }

  const send = () => {
    const body = text.trim()
    if (!body || busy || refused) return
    onSend(body)
    update('', 0)
    setDismissed(undefined)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return
    const item = shown[selected]
    if (shown.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((selected + step + shown.length) % shown.length)
    } else if (item && (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey))) {
      const complete =
        item.kind === 'command' ? text.trim() === `/${item.command.name}` : mention === undefined
      if (!complete) {
        event.preventDefault()
        pick(item)
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        send()
      }
    } else if (shown.length && event.key === 'Escape') {
      event.preventDefault()
      setDismissed(listKey)
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      send()
    }
  }

  return (
    <div className="relative">
      {shown.length ? (
        <ul
          role="listbox"
          aria-label={commandMode ? 'Commands' : 'People'}
          className="absolute right-0 bottom-full left-0 mb-2 max-h-64 overflow-y-auto rounded-[10px] border border-line-strong bg-panel p-1 shadow-[var(--overlay-shadow)]"
        >
          {shown.map((item, index) => (
            <li
              key={suggestionKey(item)}
              role="option"
              aria-selected={index === selected}
              onMouseDown={(event) => {
                event.preventDefault()
                pick(item)
              }}
              onMouseEnter={() => setActive(index)}
              className={`flex cursor-pointer items-center gap-2 rounded-[7px] px-2 py-1.5 ${
                index === selected ? 'bg-raise' : ''
              }`}
            >
              <SuggestionRow item={item} />
            </li>
          ))}
        </ul>
      ) : null}
      <div
        className={`flex flex-col rounded-[12px] border bg-panel transition-colors focus-within:border-line-strong ${
          commandMode ? 'border-code/40' : 'border-line'
        }`}
      >
        <textarea
          ref={input}
          aria-label="Message"
          value={text}
          rows={Math.min(Math.max(text.split('\n').length, 1), 8)}
          onChange={(event) => update(event.target.value, event.target.selectionStart)}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          placeholder={
            scope === undefined
              ? 'Message the thread, @ to mention'
              : 'Message the thread, @ to mention, / for commands'
          }
          autoComplete="off"
          spellCheck={!commandMode}
          className={`resize-none bg-transparent px-3 pt-2.5 pb-1 text-[13px] outline-none placeholder:text-dim ${
            commandMode ? 'font-mono' : ''
          }`}
        />
        <div className="flex items-center gap-2 px-2 pb-2 text-[11px] text-muted">
          {refused ? (
            <span className="inline-flex items-center gap-1 text-warn">
              <SquareSlash className="size-3.5" aria-hidden /> Commands run in a repository or group
              thread
            </span>
          ) : commandMode ? (
            <span className="inline-flex items-center gap-1 text-code">
              <SquareSlash className="size-3.5" aria-hidden /> Command about{' '}
              <span className="mono">{scope}</span>
            </span>
          ) : agentWillReply ? (
            <span className="inline-flex items-center gap-1 text-accent">
              <BrandIcon className="size-3.5" /> Holtkeeper will reply
            </span>
          ) : (
            <span>Only people read this; mention @holtkeeper to ask the agent.</span>
          )}
          <span className="ml-auto hidden items-center gap-1 sm:inline-flex">
            <Kbd>Enter</Kbd> send <Kbd>Shift+Enter</Kbd> new line
          </span>
          <Button
            size="sm"
            variant="primary"
            isIconOnly
            aria-label="Send"
            isDisabled={!text.trim() || busy || refused}
            onPress={send}
          >
            <ArrowUp className="size-3.5" aria-hidden />
          </Button>
        </div>
      </div>
    </div>
  )
}
