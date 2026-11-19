import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Agent, Toolset } from '@holtkeeper/agent'
import type { Discussion, DiscussionNote, GitForge, RepoRef } from '@holtkeeper/forge'
import { z } from 'zod'

import { KEEP_ENGLISH, recheckThreads, runTracked } from './agent.ts'
import { type OpenThread, isOurNote } from './dedupe.ts'
import { threadNote } from './format.ts'
import type { ReviewMessages } from './messages.ts'
import type { ReviewUsage } from './schema.ts'
import {
  ANSWER_RULES,
  MAX_THREAD_ANSWERS,
  type ThreadAnswer,
  answerSchema,
  answersIn,
  codeAround,
  postThreadAnswer,
  replyToThread,
  reviewThreadsState,
  threadConversation,
} from './thread.ts'

/** A thread Holtkeeper's review started in which a person had the last word. */
export interface PendingReply {
  discussion: Discussion
  /** The latest note, the one that gets the answer. */
  reply: DiscussionNote
  /** Every note people left after our last one, oldest first; ends with `reply`. */
  unanswered: DiscussionNote[]
}

/** Notes of Holtkeeper's other features (chat cards and the like), which are not review threads. */
const OTHER_FEATURE = /<!-- holtkeeper:(?!review)/

/**
 * The threads of `discussions` that Holtkeeper's review started and a person answered last, in
 * the forge's order. Threads another Holtkeeper feature started are left out.
 */
export function repliedThreads(
  discussions: readonly Discussion[],
  botUsername?: string,
): PendingReply[] {
  return discussions.flatMap((discussion): PendingReply[] => {
    const notes = discussion.notes.filter((note) => !note.system)
    const first = notes[0]
    const reply = notes.at(-1)
    if (!first || !reply || reply === first) return []
    if (!isOurNote(first, botUsername) || OTHER_FEATURE.test(first.body)) return []
    if (isOurNote(reply, botUsername)) return []
    const lastOurs = notes.findLastIndex((note) => isOurNote(note, botUsername))
    return [{ discussion, reply, unanswered: notes.slice(lastOurs + 1) }]
  })
}

/**
 * The replies of a merge request that still wait for an answer: `repliedThreads` minus those whose
 * latest note carries Holtkeeper's `done` mark (it was read and needs no answer). A forge without
 * marks, or one that fails to read them, counts every replied thread.
 */
export async function pendingReplies(options: {
  forge: GitForge
  repo: RepoRef
  mr: number
  botUsername?: string
}): Promise<PendingReply[]> {
  const { forge, repo, mr } = options
  if (!forge.listDiscussions) throw new Error(`forge ${forge.kind} cannot list discussions`)
  const replied = repliedThreads(await forge.listDiscussions(repo.path, mr), options.botUsername)
  const done = await Promise.all(
    replied.map(
      async (pending) =>
        (await forge
          .noteMarks?.(repo.path, mr, pending.reply.id)
          .then((marks) => marks.includes('done'))
          .catch(() => false)) ?? false,
    ),
  )
  return replied.filter((_, index) => !done[index])
}

/**
 * What a reply asks of the reviewer: `ack` nothing (thanks, noted, will do), `fixed` to confirm
 * that the code no longer has the problem, `discuss` an answer in words.
 */
export type ReplyKind = 'ack' | 'fixed' | 'discuss'

const triageSchema = z.object({
  threads: z.array(z.object({ id: z.string(), kind: z.enum(['ack', 'fixed', 'discuss']) })),
})

const MAX_TRIAGE_TEXT = 1500

const clip = (text: string) =>
  text.length > MAX_TRIAGE_TEXT ? `${text.slice(0, MAX_TRIAGE_TEXT)}\n[...]` : text

/**
 * Sorts replies by what they ask for with one call of the `fast` tier without tools. Anything the
 * call leaves out, and everything when it fails, is `discuss`, so a doubtful reply always gets a
 * full answer.
 */
export async function triageReplies(options: {
  agent: Agent
  pending: readonly PendingReply[]
  botUsername?: string
  usage: ReviewUsage
  log?: (line: string) => void
  signal?: AbortSignal
}): Promise<Map<string, ReplyKind>> {
  const kinds = new Map<string, ReplyKind>(
    options.pending.map((pending) => [pending.discussion.id, 'discuss']),
  )
  if (options.pending.length === 0) return kinds
  const scratch = await mkdtemp(join(tmpdir(), 'holtkeeper-replies-'))
  try {
    const result = await runTracked(
      options.agent,
      {
        dir: scratch,
        capabilities: [],
        system: [
          'People replied in code review threads. Sort each reply by what it asks of the reviewer.',
          '- `ack`: nothing to answer: thanks, agreement, "noted", a promise to do it later.',
          '- `fixed`: the reply only says the problem is already fixed or no longer in the code, and asks nothing.',
          '- `discuss`: everything else: a question, a disagreement, an explanation why the comment is wrong or does not apply, a request, or a reply that says it is fixed and also asks or argues something.',
          'When in doubt answer `discuss`.',
        ].join('\n'),
        prompt: options.pending
          .map((pending) => {
            const comment = pending.discussion.notes.find((note) => !note.system)
            return [
              `## Thread ${pending.discussion.id}`,
              `Review comment:\n${clip(threadConversation(comment ? [comment] : [], options.botUsername))}`,
              `Replies since:\n${clip(threadConversation(pending.unanswered, options.botUsername))}`,
            ].join('\n\n')
          })
          .join('\n\n'),
        output: triageSchema,
        taskKind: 'triage',
        tier: 'fast',
        maxTurns: 1,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      options.usage,
    )
    for (const { id, kind } of result.output?.threads ?? []) if (kinds.has(id)) kinds.set(id, kind)
  } catch (error) {
    options.log?.(
      `sorting replies failed, answering all in full: ${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
  return kinds
}

/** What the agent gets to answer replies with, set up once the first reply needs the code. */
export interface ReplyWorkspace {
  /** Checkout at the merge request head. */
  dir?: string
  toolsets?: readonly Toolset[]
  /** The repository's resolved rules, the task's stable `context`. */
  context?: string
}

/** Most threads one agent call answers together; more are answered in several calls. */
export const REPLY_BATCH = 6

const batchSchema = z.object({ answers: z.array(answerSchema.extend({ id: z.string() })) })

/**
 * Answers the latest reply of several threads in one call of the `main` tier, each thread on its
 * own. Returns the answers by thread id; a thread the agent left out has none.
 */
export async function answerThreads(options: {
  forge: GitForge
  repo: RepoRef
  pending: readonly PendingReply[]
  agent: Agent
  workspace: ReplyWorkspace
  botUsername?: string
  language?: string
  /** `reviewThreadsState` of the merge request, shown with general threads. */
  reviewState?: string
  usage: ReviewUsage
  signal?: AbortSignal
}): Promise<Map<string, ThreadAnswer>> {
  const { workspace } = options
  const scratch = workspace.dir ? undefined : await mkdtemp(join(tmpdir(), 'holtkeeper-reply-'))
  try {
    const threads = await Promise.all(
      options.pending.map(async ({ discussion }) => {
        const position = discussion.position
        const code = position
          ? await codeAround(
              {
                forge: options.forge,
                repo: options.repo,
                ...(workspace.dir && { dir: workspace.dir }),
              },
              position.path,
              position.line,
              position.headSha,
            )
          : undefined
        return [
          `## Thread ${discussion.id}${position ? ` on ${position.path}:${position.line}` : ' (general)'}`,
          code ? `Code at the head:\n\`\`\`\n${code}\n\`\`\`` : '',
          !position && options.reviewState ? options.reviewState : '',
          `Conversation:\n\n${threadConversation(
            discussion.notes.filter((note) => !note.system),
            options.botUsername,
          )}`,
        ]
          .filter(Boolean)
          .join('\n\n')
      }),
    )
    const result = await runTracked(
      options.agent,
      {
        dir: workspace.dir ?? scratch ?? '',
        capabilities: workspace.dir ? ['read', 'search'] : [],
        system: [
          'You are the code reviewer who started these merge request threads. Answer the latest reply of every thread, one answer per thread with its `id`.',
          'The threads are independent: check each against the code on its own, and never let one conversation decide another.',
          ...ANSWER_RULES,
          `${options.language ? `Write in ${options.language}.` : 'Write each answer in the language of the reply it answers.'} ${KEEP_ENGLISH}`,
        ].join('\n'),
        prompt: threads.join('\n\n'),
        output: batchSchema,
        taskKind: 'review',
        tier: 'main',
        ...(workspace.context ? { context: workspace.context } : {}),
        ...(workspace.dir && workspace.toolsets ? { toolsets: workspace.toolsets } : {}),
        maxTurns: Math.min(40, 10 + 5 * options.pending.length),
        ...(options.signal ? { signal: options.signal } : {}),
      },
      options.usage,
    )
    return new Map((result.output?.answers ?? []).map(({ id, ...answer }) => [id, answer]))
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true })
  }
}

/** How one pending reply ended; see `answerReplies`. */
export interface ReplyOutcome {
  discussionId: string
  path?: string
  line?: number
  /**
   * `explain`, `concede` and `update` are answers in words; `fixed` confirmed the fix and resolved
   * the thread, `open` said what the code still has; `ack` needed no answer; `skipped` got none.
   */
  action: ThreadAnswer['action'] | 'fixed' | 'open' | 'ack' | 'skipped'
  replied: boolean
  resolved: boolean
  /** The status note of `fixed` and `open`, or why the reply was skipped. */
  reason?: string
}

export interface AnswerRepliesOptions {
  forge: GitForge
  repo: RepoRef
  mr: { id: number; headSha: string }
  /** The replies to answer, from `pendingReplies`. */
  pending: readonly PendingReply[]
  agent: Agent
  /** Called at most once, when a reply needs the code or a full answer. */
  workspace?: () => Promise<ReplyWorkspace>
  /** Texts of the status notes; called at most once, when one is posted. English without it. */
  messages?: () => Promise<ReviewMessages>
  botUsername?: string
  language?: string
  /** Shows the rule citations of an answer in words before it is posted (`citationRenderer`). */
  cite?: (text: string) => Promise<string>
  usage: ReviewUsage
  log?: (line: string) => void
  signal?: AbortSignal
}

/**
 * Answers every pending reply of a merge request in one run. Replies are sorted first
 * (`triageReplies`): an `ack` gets the `done` mark and no note; a `fixed` claim on a diff line is
 * checked against the code like a re-check after new commits and answered with a status note,
 * resolving the thread when the problem is gone; everything else, and a claim the check could not
 * settle, gets an answer in words, several threads per agent call (`answerThreads`) with a call of
 * its own (`replyToThread`) for a thread the batch left out. A thread that got a newer note while
 * the agent worked is skipped: that note queues its own run. A thread Holtkeeper already answered
 * `MAX_THREAD_ANSWERS` times gets only the `done` mark. General threads are answered with the
 * current state of our diff threads (`reviewThreadsState`). Answered notes lose the `seen` mark.
 */
export async function answerReplies(options: AnswerRepliesOptions): Promise<ReplyOutcome[]> {
  const { forge, repo, mr, pending } = options
  if (pending.length === 0) return []
  if (!forge.replyToDiscussion) throw new Error(`forge ${forge.kind} cannot reply to discussions`)
  const reply = forge.replyToDiscussion.bind(forge)
  const outcomes = new Map<string, ReplyOutcome>()
  const record = (
    item: PendingReply,
    outcome: Pick<ReplyOutcome, 'action' | 'replied' | 'resolved' | 'reason'>,
  ) => {
    const position = item.discussion.position
    outcomes.set(item.discussion.id, {
      discussionId: item.discussion.id,
      ...(position && { path: position.path, line: position.line }),
      ...outcome,
    })
  }
  const unmark = async (item: PendingReply) => {
    const remove = forge.removeNoteMark?.bind(forge)
    if (!remove) return
    await Promise.all(
      item.unanswered.map((note) =>
        remove(repo.path, mr.id, note.id, 'seen').catch(() => undefined),
      ),
    )
  }
  const latestNotes = async () => {
    const discussions = (await forge.listDiscussions?.(repo.path, mr.id)) ?? []
    return new Map(
      discussions.map((discussion) => [
        discussion.id,
        discussion.notes.findLast((note) => !note.system)?.id,
      ]),
    )
  }
  const changed = (item: PendingReply) =>
    record(item, {
      action: 'skipped',
      replied: false,
      resolved: false,
      reason: 'the thread changed while answering',
    })

  // Sorting and checking run on the `fast` tier; `usage.model` names the model of the answers.
  const side: ReviewUsage = { turns: 0 }
  const done = () => {
    const { usage } = options
    usage.turns += side.turns
    if (side.costUsd !== undefined) usage.costUsd = (usage.costUsd ?? 0) + side.costUsd
    if (side.inputTokens !== undefined)
      usage.inputTokens = (usage.inputTokens ?? 0) + side.inputTokens
    if (side.outputTokens !== undefined)
      usage.outputTokens = (usage.outputTokens ?? 0) + side.outputTokens
    if (!usage.model && side.model) usage.model = side.model
    return pending.flatMap((item) => outcomes.get(item.discussion.id) ?? [])
  }

  // Past the answer limit the decision is the author's: no more notes, only the done mark.
  const capped = pending.filter(
    (item) => answersIn(item.discussion.notes, options.botUsername) >= MAX_THREAD_ANSWERS,
  )
  for (const item of capped) {
    // oxlint-disable-next-line no-await-in-loop -- sequential: forges rate-limit reactions
    await forge.addNoteMark?.(repo.path, mr.id, item.reply.id, 'done').catch(() => undefined)
    // oxlint-disable-next-line no-await-in-loop
    await unmark(item)
    record(item, {
      action: 'skipped',
      replied: false,
      resolved: false,
      reason: 'answer limit reached',
    })
  }
  const open = pending.filter((item) => !capped.includes(item))
  if (open.length === 0) return done()

  const kinds = await triageReplies({
    agent: options.agent,
    pending: open,
    ...(options.botUsername ? { botUsername: options.botUsername } : {}),
    usage: side,
    ...(options.log ? { log: options.log } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  })
  const of = (kind: ReplyKind) => open.filter((item) => kinds.get(item.discussion.id) === kind)

  for (const item of of('ack')) {
    // oxlint-disable-next-line no-await-in-loop -- sequential: forges rate-limit reactions
    await forge.addNoteMark?.(repo.path, mr.id, item.reply.id, 'done').catch(() => undefined)
    // oxlint-disable-next-line no-await-in-loop
    await unmark(item)
    record(item, { action: 'ack', replied: false, resolved: false })
  }

  const claims = of('fixed')
  const inWords = new Set(of('discuss'))
  if (claims.length + inWords.size === 0) return done()
  const workspace = (await options.workspace?.()) ?? {}

  const checkable = workspace.dir ? claims.filter((item) => item.discussion.position) : []
  for (const item of claims) if (!checkable.includes(item)) inWords.add(item)
  if (checkable.length && workspace.dir) {
    const dir = workspace.dir
    const threads = await Promise.all(
      checkable.map(async (item) => {
        const position = item.discussion.position ?? { path: '', line: 0, headSha: '' }
        const first = item.discussion.notes.find((note) => !note.system)
        const thread: OpenThread = {
          discussionId: item.discussion.id,
          path: position.path,
          line: position.line,
          text: threadConversation(first ? [first] : [], options.botUsername),
          ours: true,
          reply: {
            noteId: item.reply.id,
            author: item.reply.author,
            text: threadConversation(item.unanswered, options.botUsername),
          },
        }
        return {
          thread,
          code: await codeAround({ forge, repo, dir }, position.path, position.line, mr.headSha),
        }
      }),
    )
    const verdicts = await recheckThreads({
      agent: options.agent,
      dir,
      threads,
      usage: side,
      ...(options.language ? { language: options.language } : {}),
      ...(workspace.toolsets ? { toolsets: workspace.toolsets } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    }).catch((error: unknown) => {
      options.log?.(
        `checking fixed claims failed, answering them in full: ${error instanceof Error ? error.message : String(error)}`,
      )
      return new Map<string, never>()
    })
    const settled = checkable.filter((item) => {
      const verdict = verdicts.get(item.discussion.id)
      const clear = verdict && verdict.status !== 'unclear' && !verdict.needsAnswer
      if (!clear) inWords.add(item)
      return clear
    })
    if (settled.length) {
      const [latest, messages] = await Promise.all([latestNotes(), options.messages?.()])
      for (const item of settled) {
        const verdict = verdicts.get(item.discussion.id)
        if (!verdict) continue
        if (latest.get(item.discussion.id) !== item.reply.id) {
          changed(item)
          continue
        }
        const fixed = verdict.status === 'fixed'
        // oxlint-disable-next-line no-await-in-loop -- sequential: forges rate-limit note creation
        await reply(
          repo.path,
          mr.id,
          item.discussion.id,
          threadNote(fixed ? 'resolved' : 'replied', verdict.note, mr.headSha, messages),
        )
        const resolved =
          fixed && item.discussion.resolvable && forge.resolveDiscussion !== undefined
        // oxlint-disable-next-line no-await-in-loop
        if (resolved) await forge.resolveDiscussion?.(repo.path, mr.id, item.discussion.id, true)
        // oxlint-disable-next-line no-await-in-loop
        await unmark(item)
        record(item, {
          action: fixed ? 'fixed' : 'open',
          replied: true,
          resolved,
          reason: verdict.note,
        })
      }
    }
  }

  const general = [...inWords].some((item) => !item.discussion.position)
  const reviewState = general
    ? reviewThreadsState(
        (await forge.listDiscussions?.(repo.path, mr.id).catch(() => undefined)) ?? [],
        options.botUsername,
      )
    : ''

  const answerAlone = async (item: PendingReply) => {
    const result = await replyToThread({
      forge,
      repo,
      mr: mr.id,
      discussion: item.discussion,
      agent: options.agent,
      ...(workspace.dir ? { dir: workspace.dir } : {}),
      ...(workspace.toolsets ? { toolsets: workspace.toolsets } : {}),
      ...(workspace.context ? { context: workspace.context } : {}),
      ...(options.botUsername ? { botUsername: options.botUsername } : {}),
      ...(options.language ? { language: options.language } : {}),
      usage: options.usage,
      ...(options.cite ? { cite: options.cite } : {}),
      ...(reviewState && { reviewState }),
      stillPending: async () => (await latestNotes()).get(item.discussion.id) === item.reply.id,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    if (result.replied) await unmark(item)
    record(item, {
      action: result.action,
      replied: result.replied,
      resolved: result.resolved,
      ...(result.reason ? { reason: result.reason } : {}),
    })
  }

  const queue = open.filter((item) => inWords.has(item))
  for (let start = 0; start < queue.length; start += REPLY_BATCH) {
    const batch = queue.slice(start, start + REPLY_BATCH)
    const [only] = batch
    if (batch.length === 1 && only) {
      // oxlint-disable-next-line no-await-in-loop -- batches run one after another on purpose
      await answerAlone(only)
      continue
    }
    // oxlint-disable-next-line no-await-in-loop
    const answers = await answerThreads({
      forge,
      repo,
      pending: batch,
      agent: options.agent,
      workspace,
      ...(options.botUsername ? { botUsername: options.botUsername } : {}),
      ...(options.language ? { language: options.language } : {}),
      ...(reviewState && { reviewState }),
      usage: options.usage,
      ...(options.signal ? { signal: options.signal } : {}),
    }).catch((error: unknown) => {
      if (options.signal?.aborted) throw error
      options.log?.(
        `answering ${batch.length} threads together failed, answering one by one: ${error instanceof Error ? error.message : String(error)}`,
      )
      return new Map<string, ThreadAnswer>()
    })
    // oxlint-disable-next-line no-await-in-loop
    const latest = await latestNotes()
    for (const item of batch) {
      const answer = answers.get(item.discussion.id)
      if (!answer) {
        // oxlint-disable-next-line no-await-in-loop
        await answerAlone(item)
        continue
      }
      if (latest.get(item.discussion.id) !== item.reply.id) {
        changed(item)
        continue
      }
      // oxlint-disable-next-line no-await-in-loop
      const { resolved } = await postThreadAnswer(
        { forge, repo, mr: mr.id, ...(options.cite ? { cite: options.cite } : {}) },
        item.discussion,
        answer,
      )
      // oxlint-disable-next-line no-await-in-loop
      await unmark(item)
      record(item, { action: answer.action, replied: true, resolved })
    }
  }

  return done()
}
