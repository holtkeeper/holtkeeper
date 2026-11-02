import type { ChatCommandView, ChatMessageView } from '@holtkeeper/api'
import { ArrowUp, Eraser, MessagesSquare } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useChat, useChatMutations, useRepos } from '../../api/queries.ts'
import { matchingCommands, withoutPrefix } from '../../lib/chat.ts'
import { formatRelative } from '../../lib/format.ts'
import { repoKey } from '../../lib/repo.ts'
import {
  BrandIcon,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Page,
  Placeholder,
  Select,
  notify,
} from '../../ui/index.ts'
import { ChatCard } from './ChatCard.tsx'

const ANY_REPO = '__none'

function UserBubble({ text, repo }: { text: string; repo?: string | undefined }) {
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent-soft px-3.5 py-2 font-mono text-[13px] text-accent-soft-foreground">
        {text}
      </div>
      {repo ? <span className="text-[11px] text-muted">{repo}</span> : null}
    </div>
  )
}

function Typing() {
  return (
    <div className="flex items-center gap-1 px-1 py-2" aria-label="Holtkeeper is answering">
      {[0, 1, 2].map((dot) => (
        <motion.span
          key={dot}
          className="size-1.5 rounded-full bg-muted"
          animate={{ opacity: [0.3, 1, 0.3] }}
          transition={{ duration: 1, repeat: Infinity, delay: dot * 0.15 }}
        />
      ))}
    </div>
  )
}

function Reply({ children, at }: { children: React.ReactNode; at?: string }) {
  return (
    <div className="flex gap-3">
      <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-surface shadow-surface">
        <BrandIcon name="holtkeeper" className="size-5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {children}
        {at ? <span className="text-[11px] text-muted">{formatRelative(at)}</span> : null}
      </div>
    </div>
  )
}

function Message({
  message,
  onRun,
  busy,
}: {
  message: ChatMessageView
  onRun: (command: string, repo?: string) => void
  busy: boolean
}) {
  if (message.from === 'user') return <UserBubble text={message.text ?? ''} repo={message.repo} />
  if (!message.card) return null
  return (
    <Reply at={message.updatedAt ?? message.at}>
      <ChatCard card={message.card} busy={busy} onRun={(command) => onRun(command, message.repo)} />
    </Reply>
  )
}

function Hints({
  commands,
  text,
  onPick,
}: {
  commands: readonly ChatCommandView[]
  text: string
  onPick: (name: string) => void
}) {
  const matches = matchingCommands(commands, text)
  if (matches.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {matches.map((command) => (
        <button
          key={command.name}
          type="button"
          onClick={() => onPick(command.name)}
          title={command.summary}
          className="rounded-full bg-default/60 px-2.5 py-1 font-mono text-xs text-muted transition hover:bg-default hover:text-foreground"
        >
          {command.name}
          {command.usage ? <span className="opacity-60"> {command.usage}</span> : null}
        </button>
      ))}
    </div>
  )
}

/** Holtkeeper commands in the panel: the same ones merge requests and Slack run. */
export function ChatPage() {
  const chat = useChat()
  const repos = useRepos()
  const { send, clear } = useChatMutations()
  const [text, setText] = useState('')
  const [repo, setRepo] = useState<string>(ANY_REPO)
  const [clearing, setClearing] = useState(false)
  const end = useRef<HTMLDivElement>(null)

  const messages = chat.data?.messages ?? []
  const commands = chat.data?.commands ?? []
  const pending = send.isPending ? send.variables : undefined

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages.length, pending?.text])

  const run = (command: string, about?: string) => {
    const line = withoutPrefix(command)
    if (!line) return
    send.mutate(
      { text: line, ...(about && { repo: about }) },
      { onError: (error) => notify.error('Not sent', messageOf(error)) },
    )
  }

  const submit = () => {
    if (send.isPending) return
    run(text, repo === ANY_REPO ? undefined : repo)
    setText('')
  }

  const repoOptions = [
    { id: ANY_REPO, label: 'No repository' },
    ...(repos.data?.repos ?? []).map(({ repo: ref }) => ({ id: repoKey(ref), label: ref.path })),
  ]

  return (
    <Page
      title="Chat"
      icon="chat"
      description="Run Holtkeeper commands here, in merge request comments or in Slack: the same commands and answers everywhere."
      actions={
        messages.length ? (
          <Button variant="ghost" size="sm" onPress={() => setClearing(true)}>
            <Eraser className="size-4" aria-hidden /> Clear
          </Button>
        ) : null
      }
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        {chat.isPending ? (
          <Placeholder className="h-48" />
        ) : chat.isError ? (
          <ErrorState error={chat.error} />
        ) : messages.length === 0 && !pending ? (
          <EmptyState
            icon={<MessagesSquare aria-hidden />}
            title="Ask Holtkeeper"
            description="Pick a repository below and try release, or type help for every command."
          />
        ) : (
          <div className="flex flex-col gap-5">
            <AnimatePresence initial={false}>
              {messages.map((message) => (
                <motion.div
                  key={message.id}
                  layout="position"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2 }}
                >
                  <Message message={message} onRun={run} busy={send.isPending} />
                </motion.div>
              ))}
            </AnimatePresence>
            {pending ? (
              <>
                <UserBubble text={pending.text} repo={pending.repo} />
                <Reply>
                  <Typing />
                </Reply>
              </>
            ) : null}
          </div>
        )}
        <div ref={end} />

        <div className="sticky bottom-4 flex flex-col gap-2 rounded-2xl bg-surface p-3 shadow-surface">
          <Hints commands={commands} text={text} onPick={(name) => setText(`${name} `)} />
          <form
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              submit()
            }}
          >
            <Select
              aria-label="Repository"
              className="w-48 shrink-0"
              options={repoOptions}
              value={repo}
              onChange={setRepo}
            />
            <input
              aria-label="Command"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="release deploy preprod"
              autoComplete="off"
              spellCheck={false}
              className="h-10 min-w-0 flex-1 rounded-xl bg-default/50 px-3 font-mono text-[13px] outline-none transition focus:bg-default/80 focus:ring-2 focus:ring-accent/40"
            />
            <Button
              type="submit"
              variant="primary"
              isIconOnly
              aria-label="Send"
              isDisabled={!withoutPrefix(text) || send.isPending}
            >
              <ArrowUp className="size-4" aria-hidden />
            </Button>
          </form>
        </div>
      </div>

      <ConfirmDialog
        isOpen={clearing}
        onOpenChange={setClearing}
        title="Clear the conversation?"
        confirmLabel="Clear"
        isPending={clear.isPending}
        onConfirm={() => clear.mutate(undefined, { onSuccess: () => setClearing(false) })}
      >
        <p className="text-sm text-muted">
          Messages go away for you; what commands did (versions, deploys) stays.
        </p>
      </ConfirmDialog>
    </Page>
  )
}
