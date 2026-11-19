import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Agent, Toolset } from '@holtkeeper/agent'
import type { Discussion, GitForge, RepoRef } from '@holtkeeper/forge'
import { z } from 'zod'

import { KEEP_ENGLISH, runTracked } from './agent.ts'
import { isOurNote } from './dedupe.ts'
import { replyBody } from './format.ts'
import type { ReviewUsage } from './schema.ts'

/** What the reviewer answers in one thread. */
export const answerSchema = z.object({
  /** `explain` defends or clarifies, `concede` agrees the comment was wrong, `update` proposes new code. */
  action: z.enum(['explain', 'concede', 'update']),
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
  signal?: AbortSignal
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
  '- `explain` when your comment stands: clarify it briefly with evidence from the code.',
  '- `concede` when the author is right; say so plainly and set resolve to true.',
  '- `update` when a different fix fits better: give `suggestion` with new-side `line` (and `startLine`) and the full replacement of exactly those lines.',
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
        `**${isOurNote(note, botUsername) ? 'reviewer (you)' : note.author}**:\n${note.body.replace(/<!--[\s\S]*?-->/g, '').trim()}`,
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
 * resolves the thread) or proposes an updated suggestion. Threads not started by us, and threads
 * whose last note is ours, are left alone.
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
  if (options.stillPending && !(await options.stillPending()))
    return skipped('the thread changed while answering')
  const { resolved } = await postThreadAnswer(options, discussion, answer)
  return { discussionId, action: answer.action, replied: true, resolved }
}

/**
 * Posts `answer` as a reply in `discussion`, an `update` with its suggestion in the forge's
 * markup, and resolves the thread when the answer says so and the forge can.
 */
export async function postThreadAnswer(
  options: Pick<ReplyToThreadOptions, 'forge' | 'repo' | 'mr' | 'cite'>,
  discussion: Discussion,
  answer: ThreadAnswer,
): Promise<{ resolved: boolean }> {
  const { forge, repo, mr } = options
  if (!forge.replyToDiscussion) throw new Error(`forge ${forge.kind} cannot reply to discussions`)
  const position = discussion.position
  let body = options.cite ? await options.cite(answer.body.trim()) : answer.body.trim()
  const suggestion = answer.suggestion
  if (answer.action === 'update' && suggestion && position && suggestion.line === position.line) {
    const above = suggestion.startLine ? Math.max(0, suggestion.line - suggestion.startLine) : 0
    body += `\n\n${suggestionMarkdown(suggestion.replacement, above)}`
  } else if (answer.action === 'update' && suggestion) {
    body += `\n\nSuggested change for lines ${suggestion.startLine ?? suggestion.line}-${suggestion.line}:\n\n\`\`\`\n${suggestion.replacement}\n\`\`\``
  }
  await forge.replyToDiscussion(repo.path, mr, discussion.id, replyBody(body))
  const resolved = answer.resolve && discussion.resolvable && forge.resolveDiscussion !== undefined
  if (resolved) await forge.resolveDiscussion?.(repo.path, mr, discussion.id, true)
  return { resolved }
}
