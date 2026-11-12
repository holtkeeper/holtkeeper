import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type Principal, type RepoTarget, can } from '@holtkeeper/access'
import { type Agent, BudgetExceededError, type Toolset } from '@holtkeeper/agent'
import { ToolError, defineTool } from '@holtkeeper/agent-tools'
import { BudgetDeniedError } from '@holtkeeper/ai-usage'
import { type Card, taskCard } from '@holtkeeper/chat'
import type { HoltkeeperConfig } from '@holtkeeper/core'
import type { ChatMessage, ChatMessageInput, ChatThread, ChatToolUse } from '@holtkeeper/store'
import { z } from 'zod'

import {
  CHAT_SYSTEM,
  type ChatHistory,
  type KnownPerson,
  SUMMARY_SYSTEM,
  buildChatPrompt,
  buildSummaryPrompt,
  planSummary,
  textRefs,
} from './chat-prompt.ts'
import { type ServerDeps, repoTarget } from './context.ts'
import { TaskError, createTaskGroup, postTaskCard, proposalBudget } from './tasks.ts'
import { readTranscript } from './transcripts.ts'

/** Limits of one chat reply: tier `main`, at most 12 turns and $0.40. */
const CHAT_REPLY_LIMITS = { tier: 'main', maxTurns: 12, maxCostUsd: 0.4 } as const

/** Limits of one summary refresh: a single `fast` one-shot. */
const CHAT_SUMMARY_LIMITS = { tier: 'fast', maxTurns: 1, maxCostUsd: 0.02 } as const

/** Task proposals one reply may make. */
const MAX_PROPOSALS = 3

/** Messages read per page while loading a thread's unsummarized history. */
const HISTORY_PAGE = 500

/** A reply claim older than this is left over from a process that stopped mid-reply. */
export const STALE_REPLY_MS = 10 * 60_000

/** How often a process waits for another one's reply in the same thread to finish. */
const CLAIM_RETRY_MS = 2_000

/**
 * How a chat run is accounted and limited: who asked, always as interactive work. The agent's
 * tools read only what both the thread's target and `requester` may read.
 */
export interface ChatAgentRun {
  actor: string
  interactive: true
  requester: Principal
  /** The thread's title, kept on usage records. */
  subject: string
}

/**
 * The agent chat replies run on for `target`: the thread's repository, or a stand-in target for
 * group and unscoped threads (`chat:group/<name>` with that group, `chat:team` with none).
 */
export type ChatAgentFor = (target: RepoTarget, run: ChatAgentRun) => Promise<Agent | undefined>

const parseKey = (value: string) => {
  const separator = value.indexOf(':')
  return { forge: value.slice(0, separator), path: value.slice(separator + 1) }
}

/** Whether the principal may use the chat at all: it may read some repository. */
export const hasChatAccess = (principal: Principal) =>
  principal.grants.some(
    (grant) => grant.actions.includes('*') || grant.actions.includes('repos:read'),
  )

/**
 * Whether the principal sees the thread: `repos:read` on its repository or group, or chat access
 * for unscoped threads.
 */
export function canSeeThread(
  config: HoltkeeperConfig,
  principal: Principal,
  thread: Pick<ChatThread, 'repo' | 'group'>,
): boolean {
  if (thread.repo)
    return can(principal, 'repos:read', {
      kind: 'repo',
      repo: repoTarget(config, parseKey(thread.repo)),
    })
  if (thread.group)
    return can(principal, 'repos:read', { kind: 'scope', scope: { groups: [thread.group] } })
  return hasChatAccess(principal)
}

/** Whether `repo` (`forge:path`) is a repository of a configured forge the principal may read. */
export function canReadRepo(config: HoltkeeperConfig, principal: Principal, repo: string): boolean {
  const key = parseKey(repo)
  if (!key.forge || !key.path || !config.forges[key.forge]) return false
  return can(principal, 'repos:read', { kind: 'repo', repo: repoTarget(config, key) })
}

/** Refs of a message body written in a thread (see `textRefs`), for configured forges only. */
export const bodyRefs = (config: HoltkeeperConfig, body: string) =>
  textRefs(body, (forge) => config.forges[forge] !== undefined)

/** The target the agent of a thread works for (see `ChatAgentFor`). */
function agentTarget(
  config: HoltkeeperConfig,
  thread: Pick<ChatThread, 'repo' | 'group'>,
): RepoTarget {
  if (thread.repo) return repoTarget(config, parseKey(thread.repo))
  if (thread.group) return { forge: 'chat', path: `group/${thread.group}`, groups: [thread.group] }
  return { forge: 'chat', path: 'team', groups: [] }
}

const toolName = (name: string) => name.replace(/^mcp__.+?__/, '')

/** Tools a run called and how often, from its stored transcript; empty without one. */
async function toolTraceOf(
  deps: Pick<ServerDeps, 'artifacts'>,
  ref: string | undefined,
): Promise<ChatToolUse[]> {
  if (!ref || !deps.artifacts) return []
  const lines = await readTranscript(deps.artifacts, ref).catch(() => undefined)
  const counts = new Map<string, number>()
  for (const line of lines ?? [])
    if (line.type === 'assistant')
      for (const call of line.toolCalls ?? []) {
        const name = toolName(call.name)
        counts.set(name, (counts.get(name) ?? 0) + 1)
      }
  return [...counts].map(([tool, calls]) => ({ tool, calls }))
}

interface Proposal {
  repos: string[]
  title: string
  summary: string
}

/** The `chat` toolset of one reply: `propose_task`, which collects proposals into `proposals`. */
function proposalToolset(config: HoltkeeperConfig, proposals: Proposal[]): Toolset {
  return {
    name: 'chat',
    tools: [
      defineTool({
        name: 'propose_task',
        description:
          'Proposes a code change for people to approve: the target repositories (forge:path), a one-line title and the plan an agent follows in each repository. Nothing runs until a person approves it on the card.',
        input: z.object({
          repos: z.array(z.string().min(3)).min(1).max(10),
          title: z.string().trim().min(1).max(120),
          summary: z.string().trim().min(1).max(4000).describe('the plan'),
        }),
        readOnly: false,
        run(input) {
          if (proposals.length >= MAX_PROPOSALS)
            throw new ToolError(`At most ${MAX_PROPOSALS} proposals per reply.`)
          const unknown = input.repos.find((repo) => {
            const separator = repo.indexOf(':')
            return separator < 1 || !config.forges[repo.slice(0, separator)]
          })
          if (unknown) throw new ToolError(`${unknown} is not a configured forge:path.`)
          proposals.push({
            repos: [...new Set(input.repos)],
            title: input.title,
            summary: input.summary,
          })
          return 'Proposed. People see it as a card and approve or cancel it.'
        },
      }),
    ],
  }
}

const log = (message: string) => console.error(`chat: ${message}`)

/** Agent replies in team chat threads. */
export interface ChatReplies {
  /** Starts a reply in the thread for `requester`, or queues one after the reply in progress. */
  trigger(threadId: string, requester: Principal): void
}

/**
 * Replies of the agent in team chat threads. A reply loads the history after the thread's
 * summary, first folds old messages into the summary on the `fast` tier when they pass
 * `SUMMARY_THRESHOLD_TOKENS`, then runs the agent on `main` (`CHAT_REPLY_LIMITS`) as interactive
 * work of the requester with the anonymized prompt (`buildChatPrompt`, scrubbing every `users`
 * account, the thread's remembered posters and the requester; context repositories only those the
 * requester may read). The answer, its cost, transcript, tool use and refs (`bodyRefs`) are stored
 * as an agent message; task proposals become `task` cards.
 * Failures (no agent, budget, errors) are posted as system messages. One reply per thread runs at
 * a time across processes (the thread's reply claim, `STALE_REPLY_MS`); triggers during a reply
 * run one more reply afterwards.
 */
export function chatReplies(deps: ServerDeps): ChatReplies {
  const running = new Map<string, { again?: Principal }>()

  const post = (
    thread: ChatThread,
    message: Omit<ChatMessageInput, 'id' | 'threadId' | 'createdAt' | 'mentions'>,
  ) =>
    deps.store.chat.addMessage({
      id: crypto.randomUUID(),
      threadId: thread.id,
      createdAt: deps.now().toISOString(),
      mentions: [],
      ...message,
    })
  const notice = (thread: ChatThread, body: string) => post(thread, { authorType: 'system', body })

  const propose = async (thread: ChatThread, requester: Principal, proposal: Proposal) => {
    const taskDeps = { ...deps, ...(deps.readOnly && { readOnly: deps.readOnly }) }
    try {
      const view = await createTaskGroup(
        taskDeps,
        requester,
        { kind: 'chat', title: proposal.title, prompt: proposal.summary, repos: proposal.repos },
        { source: { type: 'chat', threadId: thread.id }, trigger: 'manual' },
      )
      await postTaskCard(
        deps,
        view,
        proposal.summary,
        await proposalBudget(taskDeps, view.repos.length),
      )
    } catch (error) {
      if (!(error instanceof TaskError)) throw error
      const card: Card = taskCard(proposal.repos, proposal.summary, { status: 'cancelled' })
      await post(thread, {
        authorType: 'agent',
        body: '',
        card,
        refs: proposal.repos.map((repo) => ({ kind: 'repo', repo })),
      })
      await notice(thread, `This change cannot be proposed: ${error.message}.`)
    }
  }

  const loadHistory = async (thread: ChatThread): Promise<ChatMessage[]> => {
    const upto = thread.summary
      ? await deps.store.chat.getMessage(thread.summary.uptoMessageId)
      : undefined
    const messages: ChatMessage[] = []
    let after = upto?.seq ?? 0
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- pages follow each other's cursor
      const page = await deps.store.chat.listMessages(thread.id, { after, limit: HISTORY_PAGE })
      messages.push(...page)
      const last = page.at(-1)
      if (!last || page.length < HISTORY_PAGE) return messages
      after = last.seq
    }
  }

  const knownPeople = async (thread: ChatThread, requester: Principal): Promise<KnownPerson[]> => {
    const users = await deps.store.users.listUsers()
    return [
      ...(thread.people ?? []),
      ...users.map((user) => ({
        id: user.id,
        name: user.name,
        ...(user.email && { email: user.email }),
      })),
      {
        id: requester.id,
        name: requester.name,
        ...(requester.email && { email: requester.email }),
      },
    ]
  }

  const refreshSummary = async (
    agent: Agent,
    thread: ChatThread,
    history: ChatHistory,
  ): Promise<ChatHistory> => {
    const plan = planSummary(history)
    if (!plan) return history
    const dir = await mkdtemp(join(tmpdir(), 'holtkeeper-chat-'))
    try {
      const result = await agent.run({
        dir,
        system: SUMMARY_SYSTEM,
        prompt: buildSummaryPrompt(history, plan.fold),
        context: 'Participants are anonymous labels; keep them as written.',
        taskKind: 'chat-summary',
        capabilities: [],
        ...CHAT_SUMMARY_LIMITS,
      })
      const summary = {
        text: result.text.trim(),
        uptoMessageId: plan.uptoMessageId,
        tokens: (thread.summary?.tokens ?? 0) + plan.tokens,
      }
      await deps.store.chat.updateThread(thread.id, { summary })
      const folded = new Set(plan.fold.map((message) => message.id))
      return {
        ...history,
        summary,
        messages: history.messages.filter((message) => !folded.has(message.id)),
      }
    } catch (error) {
      log(
        `summarizing thread ${thread.id} failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      return history
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  const answer = async (threadId: string, requester: Principal) => {
    const thread = await deps.store.chat.getThread(threadId)
    if (!thread || thread.archived) return
    const agent = await deps.chatAgentFor?.(agentTarget(deps.config, thread), {
      actor: requester.id,
      interactive: true,
      requester,
      subject: thread.title || 'chat',
    })
    if (!agent) {
      await notice(thread, 'No AI provider is configured, so Holtkeeper cannot reply here.')
      return
    }
    const dir = await mkdtemp(join(tmpdir(), 'holtkeeper-chat-'))
    try {
      const people = await knownPeople(thread, requester)
      const contextRepos = thread.contextRepos.filter((repo) =>
        canReadRepo(deps.config, requester, repo),
      )
      const history = await refreshSummary(agent, thread, {
        participants: thread.participants,
        people,
        ...(thread.summary && { summary: thread.summary }),
        messages: await loadHistory(thread),
        contextRepos,
      })
      const proposals: Proposal[] = []
      const result = await agent.run({
        dir,
        system: CHAT_SYSTEM,
        prompt: buildChatPrompt(history),
        taskKind: 'chat',
        capabilities: [],
        toolsets: [proposalToolset(deps.config, proposals)],
        ...CHAT_REPLY_LIMITS,
      })
      const toolTrace = await toolTraceOf(deps, result.transcriptRef)
      const body = result.text.trim()
      await post(thread, {
        authorType: 'agent',
        body,
        refs: bodyRefs(deps.config, body),
        ...(toolTrace.length > 0 && { toolTrace }),
        ...(result.costUsd !== undefined && { costUsd: result.costUsd }),
        ...(result.transcriptRef !== undefined && { transcriptRef: result.transcriptRef }),
      })
      for (const proposal of proposals)
        // oxlint-disable-next-line no-await-in-loop -- proposals keep their order
        await propose(thread, requester, proposal)
    } catch (error) {
      if (error instanceof BudgetDeniedError)
        await notice(
          thread,
          'The weekly AI budget is used up, so Holtkeeper cannot reply until it resets.',
        )
      else if (error instanceof BudgetExceededError)
        await notice(
          thread,
          `The reply stopped at its $${CHAT_REPLY_LIMITS.maxCostUsd.toFixed(2)} cap. Ask a narrower question.`,
        )
      else {
        log(
          `replying in thread ${thread.id} failed: ${error instanceof Error ? error.message : String(error)}`,
        )
        await notice(thread, 'Holtkeeper could not reply. Try again in a moment.')
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  const claimant = crypto.randomUUID()
  const claim = async (threadId: string): Promise<'won' | 'held' | 'gone'> => {
    const at = deps.now()
    const thread = await deps.store.chat.updateThread(threadId, {
      claimReply: {
        by: claimant,
        at: at.toISOString(),
        staleBefore: new Date(at.getTime() - STALE_REPLY_MS).toISOString(),
      },
    })
    if (!thread) return 'gone'
    return thread.replyingBy === claimant ? 'won' : 'held'
  }
  const waitForClaim = async (threadId: string): Promise<boolean> => {
    for (let attempt = 0; attempt * CLAIM_RETRY_MS <= STALE_REPLY_MS; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each attempt waits for the previous one
      const outcome = await claim(threadId)
      if (outcome !== 'held') return outcome === 'won'
      // oxlint-disable-next-line no-await-in-loop -- see above
      await new Promise((resolve) => setTimeout(resolve, CLAIM_RETRY_MS))
    }
    return false
  }

  const loop = async (threadId: string, requester: Principal) => {
    let next: Principal | undefined = requester
    while (next) {
      const current: Principal = next
      running.set(threadId, {})
      try {
        // oxlint-disable-next-line no-await-in-loop -- replies of one thread run one after another
        if (await waitForClaim(threadId))
          try {
            // oxlint-disable-next-line no-await-in-loop -- see above
            await answer(threadId, current)
          } finally {
            // oxlint-disable-next-line no-await-in-loop -- see above
            await deps.store.chat.updateThread(threadId, { releaseReply: claimant })
          }
      } catch (error) {
        log(
          `reply in thread ${threadId}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      next = running.get(threadId)?.again
    }
    running.delete(threadId)
  }

  return {
    trigger(threadId, requester) {
      const active = running.get(threadId)
      if (active) {
        active.again = requester
        return
      }
      const work = loop(threadId, requester)
      if (deps.onBackground) deps.onBackground(work)
      else void work
    },
  }
}
