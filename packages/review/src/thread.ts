import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Agent, Toolset } from '@holtkeeper/agent'
import type { Discussion, GitForge, RepoRef } from '@holtkeeper/forge'
import { z } from 'zod'

import { KEEP_ENGLISH, runTracked } from './agent.ts'
import { plainCitations } from './cite.ts'
import { isOurNote } from './dedupe.ts'
import { replyBody, threadNote } from './format.ts'
import type { ReviewMessages } from './messages.ts'
import type { ReviewUsage } from './schema.ts'

/** What the reviewer answers in one thread. */
export const answerSchema = z.object({
  /**
   * `explain` defends or clarifies, `concede` agrees the comment was wrong, `update` proposes new
   * code, `fixed` confirms from the code that the problem is gone, `open` says what the code still
   * has after a fix claim, `none` needs no answer (thanks, a promise to fix it later).
   */
  action: z.enum(['explain', 'concede', 'update', 'fixed', 'open', 'none']),
  body: z.string(),
  suggestion: z
    .object({
      startLine: z.number().int().optional(),
      line: z.number().int(),
      replacement: z.string(),
    })
    .optional(),
  /** Whether the thread can be resolved after this answer. */
  resolve: z.boolean(),
})

export type ThreadAnswer = z.infer<typeof answerSchema>

export interface ReplyToThreadOptions {
  forge: GitForge
  repo: RepoRef
  /** Merge request number. */
  mr: number
  /** The thread, or its id to look it up. */
  discussion: Discussion | string
  agent: Agent
  /** Checkout at the merge request head; the agent reads code there. Without it only the excerpt from the forge is shown. */
  dir?: string
  botUsername?: string
  language?: string
  usage?: ReviewUsage
  /** Mounted for the agent when there is a checkout, e.g. code navigation tools. */
  toolsets?: readonly Toolset[]
  /** The repository's resolved rules, passed as the task's stable `context`. */
  context?: string
  /**
   * Asked right before posting: `false` when the thread got a newer note while the agent worked,
   * so the answer is dropped instead of posted next to it.
   */
  stillPending?: () => Promise<boolean>
  /** Shows the rule citations of the answer before it is posted (`citationRenderer`). */
  cite?: (text: string) => Promise<string>
  /** `reviewThreadsState` of the merge request, shown with a general thread. */
  reviewState?: string
  /** The merge request head that `fixed` and `open` notes name; without it they are plain answers. */
  head?: string
  /** Texts of the `fixed` and `open` notes, read only when one is posted; English without it. */
  messages?: () => Promise<ReviewMessages | undefined>
  signal?: AbortSignal
}

/**
 * Our review threads on diff lines as the reply agent reads them: each with its state, location
 * and title. Empty when there are none.
 */
export function reviewThreadsState(
  discussions: readonly Discussion[],
  botUsername?: string,
): string {
  const lines = discussions.flatMap((discussion) => {
    const first = discussion.notes.find((note) => !note.system)
    if (!discussion.position || !first || !isOurNote(first, botUsername)) return []
    const body = first.body.replace(/<!--[\s\S]*?-->/g, '').trim()
    const title = /— \*\*(.+?)\*\*/.exec(body)?.[1] ?? body.split('\n')[0]?.slice(0, 120) ?? ''
    const state = discussion.resolved ? 'resolved' : 'open'
    return [`- ${state}: ${discussion.position.path}:${discussion.position.line} ${title}`]
  })
  return lines.length
    ? `Your review threads now (resolved ones are settled; this list is the current state):\n${lines.join('\n')}`
    : ''
}

export interface ThreadReplyResult {
  discussionId: string
  /** `skipped` when the thread is not ours or its last note is already ours. */
  action: ThreadAnswer['action'] | 'skipped'
  replied: boolean
  resolved: boolean
  reason?: string
}

/**
 * GitLab suggestion markup replacing `startLine..line` relative to the commented `line`; inside a
 * reply it is the only way to propose a change.
 */
export function suggestionMarkdown(replacement: string, above = 0): string {
  return `\`\`\`suggestion:-${above}+0\n${replacement.replace(/\n$/, '')}\n\`\`\``
}

/** How the reviewer answers a reply, as system prompt lines shared by one thread and a batch. */
export const ANSWER_RULES = [
  'First decide what the latest reply does:',
  '- it declines when it says the code stays as it is, now or in this merge request: "fine", "ok as is", "it will do for now", "we keep it", "not needed", "works in prod", "close the thread", in any language and however short, or it argues the comment is wrong. A partial change followed by such a reply is a decline too.',
  '- it claims a fix when it only says it is done, changed, added or removed.',
  '- otherwise it asks something, accepts the comment, or promises a change later.',
  'Then answer with the first rule that fits:',
  '1. A decline after you already answered a person in this thread, a decline of a `minor` or `info` comment, or a reply that asks to close the thread: the decision is theirs. `explain` in one or two sentences that you leave it to them, naming the remaining risk once; resolve true. Never argue the same point twice.',
  '2. A first decline of a `major` or `critical` comment: `explain` in at most three sentences with the concrete risk and what would settle it; resolve false. Do not restate the whole comment.',
  '3. A fix claim: check the code. `fixed` when it confirms the fix (`body` is one sentence on what changed; the thread is resolved), `open` when the problem is still there (`body` says what is left).',
  '4. Thanks, agreement or a promise to change the code later, with no question: `none`; nothing is posted. A decline or a fix claim is never `none`.',
  '5. Otherwise: `explain` to clarify your comment with evidence from the code, `concede` when the author is right (resolve true), or `update` when a different fix fits better (give `suggestion` with new-side `line`, and `startLine`, and the full replacement of exactly those lines).',
  'In a general thread, take the state of your review threads from the list in the prompt: resolved threads are settled, never present them as open or blocking.',
  'Be short and concrete. Never be defensive.',
]

/** The thread's notes as the agent reads them: who said what, our notes named `reviewer (you)`. */
export function threadConversation(
  notes: readonly { author: string; body: string }[],
  botUsername?: string,
): string {
  return notes
    .map(
      (note) =>
        `**${isOurNote(note, botUsername) ? 'reviewer (you)' : note.author}**:\n${plainCitations(note.body.replace(/<!--[\s\S]*?-->/g, '')).trim()}`,
    )
    .join('\n\n')
}

/** The 10 lines around `line` of `path` at the head, numbered: from the checkout, else the forge. */
export async function codeAround(
  options: Pick<ReplyToThreadOptions, 'forge' | 'repo' | 'dir'>,
  path: string,
  line: number,
  headSha: string,
) {
  const text = options.dir
    ? await Bun.file(join(options.dir, path))
        .text()
        .catch(() => undefined)
    : await options.forge.readFile(options.repo.path, path, headSha)
  if (text === undefined) return '(file not found at the head)'
  const lines = text.split('\n')
  const from = Math.max(1, line - 10)
  const to = Math.min(lines.length, line + 10)
  return lines
    .slice(from - 1, to)
    .map((content, index) => `${String(from + index).padStart(String(to).length)}  ${content}`)
    .join('\n')
}

/**
 * Answers the latest reply in one of our review threads: explains the comment, concedes it (and
 * resolves the thread), proposes an updated suggestion, confirms a fix from the code or says what
 * is still there, or posts nothing when the reply needs no answer (`none`). Threads not started by
 * us, and threads whose last note is ours, are left alone.
 */
export async function replyToThread(options: ReplyToThreadOptions): Promise<ThreadReplyResult> {
  const { forge, repo, mr } = options
  let discussion = typeof options.discussion === 'string' ? undefined : options.discussion
  const discussionId =
    typeof options.discussion === 'string' ? options.discussion : options.discussion.id
  if (!discussion) {
    if (!forge.listDiscussions) throw new Error(`forge ${forge.kind} cannot list discussions`)
    discussion = (await forge.listDiscussions(repo.path, mr)).find((d) => d.id === discussionId)
  }
  const skipped = (reason: string): ThreadReplyResult => ({
    discussionId,
    action: 'skipped',
    replied: false,
    resolved: false,
    reason,
  })
  if (!discussion) return skipped('thread not found')
  const notes = discussion.notes.filter((note) => !note.system)
  const first = notes[0]
  const last = notes.at(-1)
  if (!first || !isOurNote(first, options.botUsername))
    return skipped('thread was not started by Holtkeeper')
  if (!last || isOurNote(last, options.botUsername)) return skipped('last note is already ours')
  if (!forge.replyToDiscussion) throw new Error(`forge ${forge.kind} cannot reply to discussions`)

  const position = discussion.position
  const code = position
    ? await codeAround(options, position.path, position.line, position.headSha)
    : undefined
  const conversation = threadConversation(notes, options.botUsername)
  // Without a checkout the agent gets an empty directory, so it cannot read anything else.
  const scratch = options.dir ? undefined : await mkdtemp(join(tmpdir(), 'holtkeeper-reply-'))
  const task = runTracked(
    options.agent,
    {
      dir: options.dir ?? scratch ?? '',
      capabilities: options.dir ? ['read', 'search'] : [],
      system: [
        'You are the code reviewer who started this merge request thread. Answer the latest reply.',
        ...ANSWER_RULES,
        `${options.language ? `Write in ${options.language}.` : 'Write in the language of the latest reply.'} ${KEEP_ENGLISH}`,
      ].join('\n'),
      prompt: [
        position ? `Thread on ${position.path}:${position.line}.` : 'General thread.',
        code ? `Code at the head:\n\`\`\`\n${code}\n\`\`\`` : '',
        !position && options.reviewState ? options.reviewState : '',
        `Conversation:\n\n${conversation}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
      output: answerSchema,
      taskKind: 'review',
      tier: 'main',
      ...(options.context ? { context: options.context } : {}),
      ...(options.dir && options.toolsets ? { toolsets: options.toolsets } : {}),
      maxTurns: 15,
      ...(options.signal ? { signal: options.signal } : {}),
    },
    options.usage ?? { turns: 0 },
  )
  let result: Awaited<typeof task>
  try {
    result = await task
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true })
  }
  const answer = result.output ?? { action: 'explain' as const, body: result.text, resolve: false }
  if (answer.action === 'none')
    return { discussionId, action: 'none', replied: false, resolved: false }
  if (options.stillPending && !(await options.stillPending()))
    return skipped('the thread changed while answering')
  const { resolved } = await postThreadAnswer(options, discussion, answer)
  return { discussionId, action: answer.action, replied: true, resolved }
}

/**
 * Posts `answer` as a reply in `discussion`: an `update` with its suggestion in the forge's markup,
 * `fixed` and `open` as status notes naming `head` when given. Resolves the thread for `fixed`, and
 * for other answers when they say so, when the forge can. `none` posts nothing.
 */
export async function postThreadAnswer(
  options: Pick<ReplyToThreadOptions, 'forge' | 'repo' | 'mr' | 'cite' | 'head' | 'messages'>,
  discussion: Discussion,
  answer: ThreadAnswer,
): Promise<{ resolved: boolean }> {
  const { forge, repo, mr } = options
  if (answer.action === 'none') return { resolved: false }
  if (!forge.replyToDiscussion) throw new Error(`forge ${forge.kind} cannot reply to discussions`)
  const position = discussion.position
  let body = options.cite ? await options.cite(answer.body.trim()) : answer.body.trim()
  const status = answer.action === 'fixed' || answer.action === 'open'
  if (status && options.head) {
    await forge.replyToDiscussion(
      repo.path,
      mr,
      discussion.id,
      threadNote(
        answer.action === 'fixed' ? 'resolved' : 'replied',
        body,
        options.head,
        await options.messages?.(),
      ),
    )
  }
  const suggestion = answer.suggestion
  if (answer.action === 'update' && suggestion && position && suggestion.line === position.line) {
    const above = suggestion.startLine ? Math.max(0, suggestion.line - suggestion.startLine) : 0
    body += `\n\n${suggestionMarkdown(suggestion.replacement, above)}`
  } else if (answer.action === 'update' && suggestion) {
    body += `\n\nSuggested change for lines ${suggestion.startLine ?? suggestion.line}-${suggestion.line}:\n\n\`\`\`\n${suggestion.replacement}\n\`\`\``
  }
  if (!status || !options.head)
    await forge.replyToDiscussion(repo.path, mr, discussion.id, replyBody(body))
  const resolve = answer.action === 'fixed' || (answer.action !== 'open' && answer.resolve)
  const resolved = resolve && discussion.resolvable && forge.resolveDiscussion !== undefined
  if (resolved) await forge.resolveDiscussion?.(repo.path, mr, discussion.id, true)
  return { resolved }
}
