import type {
  AgentTranscriptView,
  ChatForm,
  ChatMessageList,
  ChatMessageRef,
  ChatMessageView,
  ChatStepStatus,
  ChatThreadView,
  GroupMatch,
} from '@holtkeeper/api'

import { shortId } from './format.ts'
import { keyAsTitle, type GroupTitleOf } from './group-titles.ts'
import { type FoldedScope, type ScopeView, foldScope } from './home-scope.ts'
import { kbId } from './knowledge.ts'

const pathOf = (repo: string) => repo.slice(repo.indexOf(':') + 1)

/** Values of a form being filled in, by field name. */
export type FormValues = Record<string, string | string[] | boolean | undefined>

const quote = (value: string) =>
  value === '' || /[\s"']/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value

/**
 * The command line a submitted form runs, as the server's `formCommand` builds it: the form's
 * command and `name=value` per filled field, quoted when needed, several values joined by commas.
 */
export function formCommand(form: ChatForm, values: FormValues): string {
  const parts = [form.command]
  for (const field of form.fields) {
    const value = values[field.name]
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0))
      continue
    parts.push(`${field.name}=${quote(Array.isArray(value) ? value.join(',') : String(value))}`)
  }
  return parts.join(' ')
}

/** The values a form starts with. */
export function initialValues(form: ChatForm): FormValues {
  const values: FormValues = {}
  for (const field of form.fields) {
    if (field.kind === 'toggle') values[field.name] = field.initial ?? false
    else if (field.kind === 'select' && field.multiple)
      values[field.name] = [field.initial ?? []].flat()
    else if (field.initial !== undefined) values[field.name] = [field.initial].flat()[0]
  }
  return values
}

/** Labels of required fields that are still empty. */
export function missingFields(form: ChatForm, values: FormValues): string[] {
  return form.fields
    .filter((field) => field.kind !== 'toggle' && !field.optional)
    .filter((field) => {
      const value = values[field.name]
      return value === undefined || value === '' || (Array.isArray(value) && value.length === 0)
    })
    .map((field) => field.label)
}

const liveStatuses = new Set<ChatStepStatus>(['running', 'pending'])
const liveDeploySteps = new Set<ChatStepStatus>([...liveStatuses, 'waiting'])

/**
 * Whether a recent card still shows a step that may change, so the page should poll faster: a
 * running, pending or waiting step, or a task step that is queued or running (a task waiting for
 * approval waits on people, not on work).
 */
export function hasLiveCards(messages: readonly ChatMessageView[], now: Date, windowHours = 24) {
  const since = now.getTime() - windowHours * 3_600_000
  return messages.some(
    (message) =>
      Date.parse(message.updatedAt ?? message.createdAt) >= since &&
      message.card?.blocks.some((block) =>
        block.type === 'steps'
          ? block.steps.some((step) => liveDeploySteps.has(step.status))
          : block.type === 'task' &&
            (block.steps ?? []).some((step) => liveStatuses.has(step.status)),
      ),
  )
}

/** The text after `/holtkeeper `, so people may type commands with or without the prefix. */
export const withoutPrefix = (text: string) => text.trim().replace(/^\/holtkeeper\s+/, '')

/** Commands whose name starts with the first word typed, for the composer's hints. */
export function matchingCommands<T extends { name: string }>(
  commands: readonly T[],
  text: string,
): T[] {
  const word = withoutPrefix(text).split(/\s/)[0]?.toLowerCase() ?? ''
  if (withoutPrefix(text).includes(' ')) return []
  return commands.filter((command) => command.name.startsWith(word))
}

/** `incoming` folded into `current` by id, newer copies winning, ordered by `seq`. */
export function mergeMessages(
  current: readonly ChatMessageView[],
  incoming: readonly ChatMessageView[],
): ChatMessageView[] {
  const byId = new Map(current.map((message) => [message.id, message]))
  for (const message of incoming) byId.set(message.id, message)
  return [...byId.values()].toSorted((a, b) => a.seq - b.seq)
}

/**
 * A cached page after a poll: new and changed messages folded in, the poll's thread, cursor and
 * time.
 */
export const withNewer = (current: ChatMessageList, poll: ChatMessageList): ChatMessageList => ({
  thread: poll.thread,
  messages: mergeMessages(current.messages, poll.messages),
  hasMore: current.hasMore,
  cursor: Math.max(current.cursor, poll.cursor),
  serverTime: poll.serverTime,
})

/** A cached page with an older page in front of it. */
export const withOlder = (current: ChatMessageList, older: ChatMessageList): ChatMessageList => ({
  ...current,
  messages: mergeMessages(current.messages, older.messages),
  hasMore: older.hasMore,
})

/** Consecutive messages of one author shown under one header. */
export interface MessageGroup {
  key: string
  authorType: ChatMessageView['authorType']
  authorId?: string
  /** Set on the first group of a calendar day: that day as `YYYY-MM-DD` in local time. */
  day?: string
  messages: ChatMessageView[]
}

const localDay = (at: string) => new Date(at).toLocaleDateString('en-CA')

/**
 * Messages in groups: one author in a row, each within `gapMinutes` of the previous one, on one
 * day. Messages with a card always start a group, so a card keeps its own header.
 */
export function groupMessages(
  messages: readonly ChatMessageView[],
  gapMinutes = 5,
): MessageGroup[] {
  const groups: MessageGroup[] = []
  let lastDay: string | undefined
  for (const message of messages) {
    const day = localDay(message.createdAt)
    const group = groups.at(-1)
    const previous = group?.messages.at(-1)
    const joins =
      group !== undefined &&
      previous !== undefined &&
      day === lastDay &&
      !message.card &&
      !previous.card &&
      group.authorType === message.authorType &&
      group.authorId === message.authorId &&
      Date.parse(message.createdAt) - Date.parse(previous.createdAt) <= gapMinutes * 60_000
    if (joins) group.messages.push(message)
    else
      groups.push({
        key: message.id,
        authorType: message.authorType,
        ...(message.authorId !== undefined && { authorId: message.authorId }),
        ...(day !== lastDay && { day }),
        messages: [message],
      })
    lastDay = day
  }
  return groups
}

/**
 * The first message the viewer has not read, given the thread's unread count. Unread counts every
 * message but the viewer's own, so walk back from the newest and skip those.
 */
export function firstUnreadId(
  messages: readonly ChatMessageView[],
  unread: number,
  me: string,
): string | undefined {
  if (unread <= 0) return undefined
  let left = unread
  let oldest: string | undefined
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!message || (message.authorType === 'human' && message.authorId === me)) continue
    oldest = message.id
    left -= 1
    if (left === 0) break
  }
  return oldest
}

/** The handle that asks the agent for a reply. */
const AGENT_HANDLE = 'holtkeeper'

/** Handles a body mentions, lowercased and without trailing dots, as the server reads them. */
export function parseMentions(body: string): string[] {
  const found = body.matchAll(/(?<![\w.@])@([\w.-]+)(?![\w./@-])/g)
  const names = [...found].map((match) => (match[1] ?? '').replace(/[.-]+$/, '').toLowerCase())
  return [...new Set(names.filter(Boolean))]
}

/** Whether posting `text` asks the agent: not a command, and a mention or a thread on auto reply. */
export const asksAgent = (text: string, autoReply: boolean): boolean =>
  text.trim() !== '' &&
  !text.trimStart().startsWith('/') &&
  (autoReply || parseMentions(text).includes(AGENT_HANDLE))

/** The `@word` being typed at `caret`: where its `@` is and what follows it so far. */
export function mentionAt(
  text: string,
  caret: number,
): { start: number; query: string } | undefined {
  const match = /(?:^|[^\w.@])@([\w.-]*)$/.exec(text.slice(0, caret))
  if (!match) return undefined
  const query = match[1] ?? ''
  return { start: caret - query.length - 1, query }
}

/** A person or the agent the mention list offers. */
export interface MentionOption {
  handle: string
  name: string
  avatarUrl?: string
  agent?: true
}

/** Options whose handle or a word of the name starts with `query`, the agent first. */
export function mentionOptions(
  people: readonly { handle: string; name: string; avatarUrl: string }[],
  query: string,
  limit = 6,
): MentionOption[] {
  const q = query.toLowerCase()
  const matches = (option: MentionOption) =>
    option.handle.startsWith(q) ||
    option.name
      .toLowerCase()
      .split(/\s+/)
      .some((word) => word.startsWith(q))
  const agent: MentionOption = { handle: AGENT_HANDLE, name: 'Holtkeeper', agent: true }
  return [agent, ...people.filter((person) => person.handle !== AGENT_HANDLE)]
    .filter(matches)
    .slice(0, limit)
}

/** `text` with the mention typed from `start` to `caret` replaced by `@handle `, and the new caret. */
export function insertMention(
  text: string,
  start: number,
  caret: number,
  handle: string,
): { text: string; caret: number } {
  const inserted = `@${handle} `
  const rest = text.slice(caret).replace(/^[\w.-]*\s?/, '')
  return { text: text.slice(0, start) + inserted + rest, caret: start + inserted.length }
}

/**
 * What a thread is about, for its list row and header: the repository path, the group (by
 * `titleOf`) or `Team`.
 */
export const threadScope = (
  thread: Pick<ChatThreadView, 'repo' | 'group'>,
  titleOf: GroupTitleOf = keyAsTitle,
): string => (thread.repo ? pathOf(thread.repo) : thread.group ? titleOf(thread.group) : 'Team')

/**
 * Threads for a scope switch position. Team-wide threads count as the viewer's own teams; on
 * *My teams* the threads of other teams fold into `others` (with the groups they are in), a group
 * position keeps that group's threads, *All I can see* everything. Without home groups *My teams*
 * shows only the team-wide threads.
 */
export const scopeThreads = <T extends Pick<ChatThreadView, 'groups'>>(
  threads: readonly T[],
  view: ScopeView,
  homeGroups: readonly GroupMatch[],
): FoldedScope<T> => foldScope(threads, view, homeGroups, (thread) => thread.groups)

/** The tool trace of a reply in one line, e.g. `knowledge ×2 · catalog`. */
export const toolSummary = (trace: readonly { tool: string; calls: number }[]): string =>
  trace.map((use) => (use.calls > 1 ? `${use.tool} ×${use.calls}` : use.tool)).join(' · ')

/** One tool call of a reply's transcript with its result. */
export interface ToolCallView {
  id: string
  name: string
  input: string
  output?: string
  isError?: boolean
}

/** The tool calls of a transcript in order, each with its result once one was written. */
export function toolCalls(lines: AgentTranscriptView['lines']): ToolCallView[] {
  const calls: ToolCallView[] = []
  const byId = new Map<string, ToolCallView>()
  for (const line of lines) {
    if (line.type === 'assistant')
      for (const call of line.toolCalls ?? []) {
        const view: ToolCallView = {
          id: call.id,
          name: call.name,
          input: typeof call.input === 'string' ? call.input : JSON.stringify(call.input),
        }
        calls.push(view)
        byId.set(call.id, view)
      }
    else if (line.type === 'tool-result') {
      const view = byId.get(line.id)
      if (!view) continue
      view.output = line.output
      if (line.isError) view.isError = true
    }
  }
  return calls
}

/** Cost of a reply in dollars: three decimals below a dollar, two above. */
export const formatCost = (usd: number): string => `$${usd.toFixed(usd < 1 ? 3 : 2)}`

/** Text of an unread badge: empty for none, `99+` past 99. */
export const unreadBadge = (count: number): string =>
  count <= 0 ? '' : count > 99 ? '99+' : String(count)

/** The unread badge of a thread row: none for threads the viewer muted. */
export const threadBadge = (thread: Pick<ChatThreadView, 'unread' | 'muted'>): string =>
  thread.muted ? '' : unreadBadge(thread.unread)

/** What a new thread sends as its title: the trimmed text, or nothing so the server names it. */
export const newThreadTitle = (text: string): { title?: string } => {
  const title = text.trim()
  return title ? { title } : {}
}

/** Whether the thread is being named: its title is pending and it already has a message. */
export const isNaming = (thread: Pick<ChatThreadView, 'titlePending' | 'messageCount'>): boolean =>
  thread.titlePending === true && thread.messageCount > 0

/** One stable key per ref, so lists can drop repeats and render keys. */
export const refKey = (ref: ChatMessageRef): string =>
  ref.kind === 'repo'
    ? `repo:${ref.repo}`
    : ref.kind === 'mr'
      ? `mr:${ref.repo}!${ref.iid}`
      : `${ref.kind}:${ref.id}`

/** How a ref reads on a chip: a repository path, `kb:<short id>`, `Task <short id>`, `path!iid`. */
export function refLabel(ref: ChatMessageRef): string {
  if (ref.kind === 'repo') return pathOf(ref.repo)
  if (ref.kind === 'mr') return `${pathOf(ref.repo)}!${ref.iid}`
  if (ref.kind === 'note') return kbId(ref.id, true)
  return `${ref.kind === 'task' ? 'Task' : 'Run'} ${shortId(ref.id)}`
}

/**
 * Every ref of `messages` once, in order of first mention, for the thread's "Cited and linked"
 * list; repositories are left out (the context column lists them on their own).
 */
export function threadRefs(messages: readonly Pick<ChatMessageView, 'refs'>[]): ChatMessageRef[] {
  const seen = new Set<string>()
  const refs: ChatMessageRef[] = []
  for (const message of messages)
    for (const ref of message.refs) {
      const key = refKey(ref)
      if (ref.kind === 'repo' || seen.has(key)) continue
      seen.add(key)
      refs.push(ref)
    }
  return refs
}

/** Repositories a thread can still take as context: readable ones not attached yet, sorted. */
export const addableRepos = (readable: readonly string[], attached: readonly string[]): string[] =>
  readable.filter((repo) => !attached.includes(repo)).toSorted()

/** What kind of thread it is, in words: about a repository, a group or the whole team. */
export const threadKind = (thread: Pick<ChatThreadView, 'repo' | 'group'>): string =>
  thread.repo ? 'Repository thread' : thread.group ? 'Group thread' : 'Team thread'
