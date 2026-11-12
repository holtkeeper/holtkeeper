import type { Card } from '@holtkeeper/chat'
import type { ChatMessage, ChatMessageRef, ChatThreadSummary } from '@holtkeeper/store'

/** Above this many estimated tokens of unsummarized history a reply first refreshes the summary. */
const SUMMARY_THRESHOLD_TOKENS = 20_000

/** Estimated tokens of recent history a summary refresh keeps verbatim. */
const SUMMARY_KEEP_TOKENS = 8_000

/** The name people mention to ask the agent for a reply. */
const AGENT_MENTION = 'holtkeeper'

/** A rough token count: four characters per token. */
const estimateTokens = (text: string) => Math.ceil(text.length / 4)

/** The label of the participant at `index`: `Participant A` … `Participant Z`, `Participant AA`, … */
export function participantLabel(index: number): string {
  let letters = ''
  let rest = index
  do {
    letters = String.fromCodePoint(65 + (rest % 26)) + letters
    rest = Math.floor(rest / 26) - 1
  } while (rest >= 0)
  return `Participant ${letters}`
}

/** Labels of `participants` (principal ids in order of first appearance). */
export function participantLabels(participants: readonly string[]): Map<string, string> {
  return new Map(participants.map((id, index) => [id, participantLabel(index)]))
}

/** Lowercased names after `@` in a message body; `@scope/package` names are not mentions. */
export function parseMentions(body: string): string[] {
  const found = body.matchAll(/(?<![\w.@])@([\w.-]+)(?![\w./@-])/g)
  const names = [...found].map((match) => (match[1] ?? '').replace(/[.-]+$/, '').toLowerCase())
  return [...new Set(names.filter(Boolean))]
}

/** Whether a message asks the agent for a reply. */
export const mentionsAgent = (mentions: readonly string[]) => mentions.includes(AGENT_MENTION)

const refKey = (ref: ChatMessageRef) =>
  ref.kind === 'repo'
    ? `repo:${ref.repo}`
    : ref.kind === 'mr'
      ? `mr:${ref.repo}!${ref.iid}`
      : `${ref.kind}:${ref.id}`

/** `refs` without repeats, first occurrence kept. */
export function uniqueRefs(refs: readonly ChatMessageRef[]): ChatMessageRef[] {
  const seen = new Set<string>()
  return refs.filter((ref) => {
    const key = refKey(ref)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * What a message body refers to, read once when the message is written: knowledge citations
 * (`kb:<id>`, bracketed or not) as notes and `forge:path` keys whose forge `isForge` accepts as
 * repositories, in order of first mention.
 */
export function textRefs(body: string, isForge: (forge: string) => boolean): ChatMessageRef[] {
  const found: { at: number; ref: ChatMessageRef }[] = []
  for (const match of body.matchAll(/(?<![\w/-])kb:([\w-]+)/g))
    found.push({ at: match.index, ref: { kind: 'note', id: match[1] ?? '' } })
  for (const match of body.matchAll(/(?<![\w/.:-])([\w-]+):([\w.-]+(?:\/[\w.-]+)+)/g)) {
    const forge = match[1] ?? ''
    const path = (match[2] ?? '').replace(/[.-]+$/, '')
    if (forge !== 'kb' && isForge(forge))
      found.push({ at: match.index, ref: { kind: 'repo', repo: `${forge}:${path}` } })
  }
  return uniqueRefs(found.toSorted((a, b) => a.at - b.at).map((entry) => entry.ref))
}

/** Someone whose identifiers must never reach the model. */
export interface KnownPerson {
  id: string
  name?: string
  email?: string
}

const escape = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)

interface Term {
  text: string
  caseSensitive: boolean
}

function termsOf(person: KnownPerson): Term[] {
  const loose = [
    person.id,
    person.id.includes(':') ? person.id.slice(person.id.lastIndexOf(':') + 1) : '',
    person.email ?? '',
    person.email?.split('@')[0] ?? '',
    person.name ?? '',
    person.name?.replaceAll(/\s+/g, '') ?? '',
  ]
  const parts = (person.name ?? '').split(/\s+/)
  return [
    ...loose.map((text) => ({ text: text.trim(), caseSensitive: false })),
    ...parts.map((text) => ({ text, caseSensitive: true })),
  ].filter((term) => term.text.length >= 3)
}

/**
 * `text` with the identifiers of `people` (ids, emails, user names, names and their parts) replaced
 * by their participant label, or `a teammate` for people without one, and any other email address
 * replaced by `[email]`. Whole names (also without their spaces, as mention handles write them)
 * match case-insensitively, single name parts only as written.
 */
export function anonymize(
  text: string,
  people: readonly KnownPerson[],
  labels: ReadonlyMap<string, string>,
): string {
  const terms = people
    .flatMap((person) =>
      termsOf(person).map((term) => ({ ...term, label: labels.get(person.id) ?? 'a teammate' })),
    )
    .toSorted((a, b) => b.text.length - a.text.length)
  let result = text
  for (const term of terms) {
    const pattern = new RegExp(
      String.raw`(?<![\w.])@?${escape(term.text)}(?![\w])`,
      term.caseSensitive ? 'g' : 'gi',
    )
    result = result.replace(pattern, (match) =>
      match.startsWith('@') ? `@${term.label}` : term.label,
    )
  }
  return result.replaceAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
}

/** A card as one line of plain text for the model: title, subtitle and task summaries. */
function cardText(card: Card): string {
  const tasks = card.blocks.flatMap((block) =>
    block.type === 'task' ? [`${block.summary} (${block.repos.join(', ')}, ${block.status})`] : [],
  )
  return [card.title, card.subtitle, ...tasks].filter(Boolean).join(' · ')
}

/** Labels of `participants` plus any human author missing from them, in order of appearance. */
function labelsFor(participants: readonly string[], messages: readonly ChatMessage[]) {
  const ids = [...participants]
  for (const message of messages)
    if (message.authorType === 'human' && message.authorId && !ids.includes(message.authorId))
      ids.push(message.authorId)
  return participantLabels(ids)
}

/**
 * One message as a line for the model: `Participant A: …` for people, `assistant: …` for the
 * agent and `system: …` for Holtkeeper's own messages (command answers as card text). Identities
 * are anonymized.
 */
function messageLine(
  message: ChatMessage,
  labels: ReadonlyMap<string, string>,
  people: readonly KnownPerson[],
): string {
  const text = [message.body.trim(), message.card ? cardText(message.card) : '']
    .filter(Boolean)
    .join('\n')
  const speaker =
    message.authorType === 'agent'
      ? 'assistant'
      : message.authorType === 'system'
        ? 'system'
        : ((message.authorId && labels.get(message.authorId)) ?? 'Participant ?')
  return `${speaker}: ${anonymize(text, people, labels)}`
}

/** What `buildChatPrompt` and the summary helpers read. */
export interface ChatHistory {
  /** The thread's participants, in order of first appearance. */
  participants: readonly string[]
  /** Everyone whose identifiers must be removed. */
  people: readonly KnownPerson[]
  summary?: ChatThreadSummary
  /** The messages after the summary, oldest first. */
  messages: readonly ChatMessage[]
  /** Repositories attached to the thread that the asker may read (`forge:path`). */
  contextRepos?: readonly string[]
}

/**
 * The user prompt of a chat reply: the repositories attached as context, the running summary, the
 * conversation up to the agent's last reply, then every message since merged into one block.
 * Participants appear only as stable `Participant X` labels; names, emails and user names never
 * do.
 */
export function buildChatPrompt(history: ChatHistory): string {
  const labels = labelsFor(history.participants, history.messages)
  const lines = history.messages.map((message) => messageLine(message, labels, history.people))
  const lastReply = history.messages.findLastIndex((message) => message.authorType === 'agent')
  const earlier = lines.slice(0, lastReply + 1)
  const fresh = lines.slice(lastReply + 1)
  return [
    ...(history.contextRepos?.length
      ? [
          `Repositories attached to this thread as context:\n${history.contextRepos.map((repo) => `- ${repo}`).join('\n')}`,
        ]
      : []),
    ...(history.summary
      ? [
          `Summary of the earlier conversation:\n${anonymize(history.summary.text, history.people, labels)}`,
        ]
      : []),
    ...(earlier.length ? [`Conversation so far:\n${earlier.join('\n')}`] : []),
    `New messages since your last reply:\n${fresh.length ? fresh.join('\n') : '(none)'}`,
    'Reply to the new messages.',
  ].join('\n\n')
}

/** Messages a summary refresh folds into the summary, and the id it then covers up to. */
export interface SummaryPlan {
  fold: ChatMessage[]
  uptoMessageId: string
  tokens: number
}

/**
 * Whether the unsummarized history is above `SUMMARY_THRESHOLD_TOKENS` and, if so, which older
 * messages to fold into the summary: everything except the newest `SUMMARY_KEEP_TOKENS` (at least
 * the newest message). `undefined` while the history is small, so a summary is only recomputed
 * after another threshold's worth of messages.
 */
export function planSummary(
  history: ChatHistory,
  limits = { threshold: SUMMARY_THRESHOLD_TOKENS, keep: SUMMARY_KEEP_TOKENS },
): SummaryPlan | undefined {
  const labels = labelsFor(history.participants, history.messages)
  const sizes = history.messages.map((message) =>
    estimateTokens(messageLine(message, labels, history.people)),
  )
  const total = sizes.reduce((sum, size) => sum + size, 0)
  if (total <= limits.threshold) return undefined
  let cut = history.messages.length
  let kept = 0
  while (cut > 0 && kept + (sizes[cut - 1] ?? 0) <= limits.keep) {
    cut -= 1
    kept += sizes[cut] ?? 0
  }
  if (cut === history.messages.length) cut -= 1
  const fold = history.messages.slice(0, cut)
  const last = fold.at(-1)
  if (!last) return undefined
  return {
    fold,
    uptoMessageId: last.id,
    tokens: sizes.slice(0, cut).reduce((sum, size) => sum + size, 0),
  }
}

/** The prompt of a summary refresh: the previous summary and the folded messages, anonymized. */
export function buildSummaryPrompt(history: ChatHistory, fold: readonly ChatMessage[]): string {
  const labels = labelsFor(history.participants, history.messages)
  return [
    ...(history.summary
      ? [`Previous summary:\n${anonymize(history.summary.text, history.people, labels)}`]
      : []),
    `Messages to fold in:\n${fold.map((message) => messageLine(message, labels, history.people)).join('\n')}`,
  ].join('\n\n')
}

/** System prompt of chat replies; stable, so it caches with the tool schemas and the Guide. */
export const CHAT_SYSTEM = [
  'You are Holtkeeper, a teammate in a team chat about the organization’s repositories.',
  'People appear only as "Participant A", "Participant B" and so on; you never learn who they are, so do not ask for names and address people by their label when it helps.',
  '"assistant" lines are your own earlier replies; "system" lines are Holtkeeper commands and notices.',
  'Answer the new messages concisely in Markdown. Use the tools to look things up instead of guessing, and cite knowledge entries as [kb:<id>].',
  'You cannot change code yourself. When a code change would help, call propose_task with the target repositories, a short title and the plan; people see a card and approve or cancel it, and an approved change runs as a separate task that opens merge requests.',
].join('\n')

/** System prompt of summary refreshes. */
export const SUMMARY_SYSTEM = [
  'You keep the running summary of a team chat.',
  'Merge the previous summary and the new messages into one summary of at most 300 words: decisions, open questions, facts found and who asked what.',
  'Keep the participant labels exactly as written. Answer with the summary only.',
].join('\n')
