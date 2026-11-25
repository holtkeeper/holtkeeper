import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RepoTarget } from '@holtkeeper/access'
import { type Agent, BudgetExceededError } from '@holtkeeper/agent'
import { BudgetDeniedError } from '@holtkeeper/ai-usage'
import type { RepoRef } from '@holtkeeper/forge'

import { CHAT_REPLY_LIMITS } from '../chat-threads.ts'
import { type ServerDeps, repoTarget } from '../context.ts'
import {
  type EnvironmentCandidate,
  type EnvironmentComparer,
  type EnvironmentSource,
  comparePrincipal,
  releaseComparer,
  releaseEnvironmentSource,
} from '../env-compare.ts'
import { type SlackPoster, slackWebPoster } from './client.ts'
import {
  comparableRows,
  previewMessage,
  startedMessage,
  summaryMessage,
  textMessage,
} from './compare-messages.ts'
import { parseCompareRequest, resolveEnvironment } from './compare-parse.ts'
import {
  type CompareRequest,
  type CompareThread,
  type CompareThreads,
  type PreviewRow,
  type RepoResult,
  compareThreads,
} from './compare-state.ts'
import { slackConnection } from './connection.ts'

/** Task kind of the run summary; `release-*` so the release rules apply. */
const COMPARE_SUMMARY_TASK = 'release-compare-summary'

/** Limits of the run summary: a single `fast` one-shot. */
const SUMMARY_LIMITS = { tier: 'fast', maxTurns: 1, maxCostUsd: 0.05 } as const

/** Repositories one request may compare. */
const MAX_REPOS = 10

/** Repositories compared at the same time. */
const RUN_CONCURRENCY = 3

/** A run older than this belonged to a process that stopped; a new confirmation restarts it. */
const COMPARE_RUN_STALE_MS = 30 * 60_000

/** Follow-up turns kept with the thread for the next answer. */
const KEPT_TURNS = 10

/** A Slack message the comparison bot looks at. */
interface SlackCompareMessage {
  channel: string
  ts: string
  /** The thread the message is in; absent for a top-level message. */
  threadTs?: string
  user: string
  text: string
}

/** The comparison conversations of the Slack app. Every method logs its failures and never throws. */
export interface SlackCompareBot {
  /**
   * A message that mentions the bot: a new request, or, in a comparison's thread, a correction,
   * confirmation or cancel while it waits and a follow-up question once it is done. The bot never
   * reacts to messages that do not mention it.
   */
  handleMention(message: SlackCompareMessage): Promise<void>
  /** A click on the preview's buttons. */
  handleAction(input: {
    channel: string
    threadTs: string
    user: string
    action: 'confirm' | 'cancel'
  }): Promise<void>
}

/** Options of `createSlackCompareBot`. */
export interface SlackCompareOptions {
  /** Default: `releaseComparer(deps)`. */
  comparer?: EnvironmentComparer
  /** Default: `releaseEnvironmentSource(deps)`. */
  environments?: EnvironmentSource
  log?: (line: string) => void
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const keyOf = (repo: RepoRef) => `${repo.forge}:${repo.path}`

const parseKey = (value: string): RepoRef => {
  const separator = value.indexOf(':')
  return { forge: value.slice(0, separator), path: value.slice(separator + 1) }
}

/** Stand-in target of parse and summary calls, which work for no single repository. */
const BOT_TARGET: RepoTarget = { forge: 'chat', path: 'slack/compare', teams: [] }

const SUMMARY_SYSTEM = `You write the overview of a comparison between the versions two deploy environments run, for a Slack thread.
In three to six short Markdown bullet points: what changed for users, what is risky (breaking changes, major dependency jumps, unfinished tasks) and what to check before upgrading. Name repositories by their path. Use only the facts given. No heading.`

const ANSWER_SYSTEM = `You answer follow-up questions in a Slack thread about a comparison of the versions two deploy environments run.
The comparison request and its results are below. Use the release tools (release_changes and the others) for details the results do not hold. Answer briefly in Markdown, in the language of the question, and link to the full report when it helps. Never invent versions, tasks or changes.`

/** A person-readable reason an agent call failed, or `undefined` for unexpected errors. */
const agentProblem = (error: unknown) => {
  if (error instanceof BudgetDeniedError)
    return 'The weekly AI budget is used up, so I cannot do this until it resets.'
  if (error instanceof BudgetExceededError)
    return 'That took more than its AI cost cap. Try a narrower request.'
  return undefined
}

const tooMany = (request: CompareRequest) =>
  request.repos.length > MAX_REPOS ? ` Only the first ${MAX_REPOS} repositories are compared.` : ''

/** What the summary and answer calls read: the request and each repository's outcome. */
const factsOf = (thread: CompareThread, results: readonly RepoResult[]) =>
  JSON.stringify(
    {
      request: thread.request,
      repositories: thread.preview.map((row) => {
        const result = results.find((entry) => keyOf(entry.repo) === keyOf(row.repo))
        return {
          repo: keyOf(row.repo),
          from: row.from,
          to: row.to,
          ...(row.problem && { problem: row.problem }),
          ...(row.range?.reversed && { behind: row.to?.environment }),
          ...(result?.error && { error: result.error }),
          ...(result?.comparison && { comparison: result.comparison }),
        }
      }),
    },
    null,
    1,
  )

/**
 * The Slack front end of environment comparisons. A mention is parsed into a request
 * (`parseCompareRequest`, tier `fast`), the versions each environment runs are read
 * (`EnvironmentSource`) and shown for confirmation; replies that mention the bot are read by the
 * same `fast` parser, which corrects the request, confirms or cancels it (the buttons do too). The run then compares each repository
 * (`EnvironmentComparer`), posts the summary with links to the full reports, and follow-up
 * questions go to the chat agent (task kind `chat`). Thread state lives in `store.kv`
 * (`compareThreads`), so it survives restarts, and each Slack message is handled once.
 */
export function createSlackCompareBot(
  deps: ServerDeps,
  options: SlackCompareOptions = {},
): SlackCompareBot {
  const log = options.log ?? ((line: string) => console.error(line))
  const threads: CompareThreads = compareThreads(deps.store, deps.now)
  const environments = options.environments ?? releaseEnvironmentSource(deps)
  const comparer = options.comparer ?? releaseComparer(deps)

  const posterOf = async (): Promise<SlackPoster | undefined> => {
    const connection = await slackConnection(deps)
    if (!connection) return undefined
    return (deps.slackPoster ?? ((token) => slackWebPoster({ token, log })))(connection.botToken)
  }

  const reply = async (
    channel: string,
    threadTs: string,
    body: { text: string; blocks: readonly Record<string, unknown>[] },
  ) => {
    const poster = await posterOf()
    if (!poster) return undefined
    const posted = await poster.post({ channel, threadTs, ...body })
    if (!posted.ok) log(`slack compare: posting in ${channel}/${threadTs} failed: ${posted.error}`)
    return posted.ok ? posted.ts : undefined
  }
  const say = (channel: string, threadTs: string, text: string) =>
    reply(channel, threadTs, textMessage(text))

  const agentFor = (user: string, subject: string, target: RepoTarget = BOT_TARGET) =>
    deps.chatAgentFor?.(target, {
      actor: `slack:${user}`,
      interactive: true,
      requester: comparePrincipal,
      subject,
    }) ?? Promise.resolve(undefined)

  const buildPreview = async (request: CompareRequest): Promise<PreviewRow[]> =>
    Promise.all(
      request.repos.slice(0, MAX_REPOS).map(async (value): Promise<PreviewRow> => {
        const repo = parseKey(value)
        let read
        try {
          read = await environments.read(repo)
        } catch (error) {
          log(`slack compare: reading environments of ${value} failed: ${messageOf(error)}`)
          return { repo, problem: 'its release state could not be read' }
        }
        if (!read) return { repo, problem: 'releases with deploy environments are not set up' }
        const names = read.environments.map((environment) => environment.name)
        const known = `known: ${names.join(', ')}`
        const sideOf = (wanted: string | undefined) => {
          if (!wanted) return undefined
          const name = resolveEnvironment(wanted, names)
          const summary = read.environments.find((environment) => environment.name === name)
          if (!summary) return undefined
          return {
            environment: summary.name,
            ...(summary.tag && { tag: summary.tag }),
            ...(summary.version && { version: summary.version }),
            status: summary.status,
          }
        }
        const from = sideOf(request.from)
        const to = sideOf(request.to)
        const base = { repo, ...(read.webUrl && { webUrl: read.webUrl }) }
        if (!request.from || !request.to)
          return { ...base, problem: `say which two environments to compare (${known})` }
        if (!from) return { ...base, problem: `no environment ${request.from} (${known})` }
        if (!to) return { ...base, problem: `no environment ${request.to} (${known})` }
        const sides = { ...base, from, to }
        if (!from.tag) return { ...sides, problem: `the version on ${from.environment} is unknown` }
        if (!to.tag) return { ...sides, problem: `the version on ${to.environment} is unknown` }
        if (from.tag === to.tag) return { ...sides, problem: 'same version on both' }
        const order =
          from.version && to.version ? read.compareVersions(from.version, to.version) : 0
        const reversed = order > 0
        return {
          ...sides,
          range: {
            from: reversed ? to.tag : from.tag,
            to: reversed ? from.tag : to.tag,
            reversed,
          },
        }
      }),
    )

  /** Parses `text` (against `previous` when given) and posts the preview, or a question back. */
  const understand = async (
    message: SlackCompareMessage,
    threadTs: string,
    previous: CompareThread | undefined,
  ) => {
    const agent = await agentFor(message.user, 'Slack comparison request')
    if (!agent) {
      await say(
        message.channel,
        threadTs,
        'No AI provider is configured, so I cannot read requests.',
      )
      return
    }
    let candidates: EnvironmentCandidate[]
    try {
      candidates = await environments.candidates()
    } catch (error) {
      log(`slack compare: listing repositories failed: ${messageOf(error)}`)
      candidates = []
    }
    let parsed
    try {
      parsed = await parseCompareRequest(agent, {
        text: message.text,
        candidates,
        ...(previous && { previous: previous.request }),
      })
    } catch (error) {
      const problem = agentProblem(error)
      if (!problem)
        log(`slack compare: parsing in ${message.channel}/${threadTs} failed: ${messageOf(error)}`)
      await say(
        message.channel,
        threadTs,
        problem ?? 'I could not read that request. Try again in a moment.',
      )
      return
    }
    if (parsed.kind === 'question') {
      await say(message.channel, threadTs, parsed.text)
      return
    }
    if (parsed.kind === 'confirm' && previous) {
      await start(previous, message.user)
      return
    }
    if (parsed.kind === 'cancel' && previous) {
      await cancel(previous)
      return
    }
    if (parsed.kind !== 'request') return
    const request = parsed.request
    const preview = await buildPreview(request)
    const at = deps.now().toISOString()
    const saved = await threads.update(message.channel, threadTs, (current) => {
      if (current?.status === 'running') return undefined
      return {
        channel: message.channel,
        threadTs,
        requestedBy: current?.requestedBy ?? message.user,
        status: 'pending',
        request,
        preview,
        turns: current?.turns ?? [],
        createdAt: current?.createdAt ?? at,
        updatedAt: at,
      }
    })
    if (!saved) {
      await say(message.channel, threadTs, 'A comparison is running in this thread already.')
      return
    }
    const body = previewMessage(request, preview)
    const ts = await reply(message.channel, threadTs, {
      ...body,
      ...(tooMany(request) && { text: `${body.text}${tooMany(request)}` }),
    })
    if (ts)
      await threads.update(message.channel, threadTs, (current) =>
        current?.status === 'pending' ? { ...current, previewTs: ts } : undefined,
      )
  }

  const cancel = async (thread: CompareThread) => {
    const cancelled = await threads.update(thread.channel, thread.threadTs, (current) =>
      current?.status === 'pending' ? { ...current, status: 'cancelled' } : undefined,
    )
    if (cancelled) await say(thread.channel, thread.threadTs, 'Cancelled.')
  }

  const compareAll = async (rows: readonly PreviewRow[]): Promise<RepoResult[]> => {
    const results: RepoResult[] = []
    const queue = [...rows]
    const worker = async () => {
      for (let row = queue.shift(); row; row = queue.shift()) {
        const range = row.range
        if (!range) continue
        try {
          // oxlint-disable-next-line no-await-in-loop -- each worker compares one repository at a time
          const comparison = await comparer.compare(row.repo, { from: range.from, to: range.to })
          results.push({ repo: row.repo, comparison })
        } catch (error) {
          log(`slack compare: comparing ${keyOf(row.repo)} failed: ${messageOf(error)}`)
          results.push({ repo: row.repo, error: messageOf(error) })
        }
      }
    }
    await Promise.all(Array.from({ length: RUN_CONCURRENCY }, worker))
    return rows.flatMap((row) => results.filter((result) => keyOf(result.repo) === keyOf(row.repo)))
  }

  const overviewOf = async (
    thread: CompareThread,
    results: readonly RepoResult[],
    user: string,
  ) => {
    if (!results.some((result) => result.comparison)) return undefined
    const agent = await agentFor(user, 'Slack comparison summary').catch(() => undefined)
    if (!agent) return undefined
    const dir = await mkdtemp(join(tmpdir(), 'holtkeeper-compare-'))
    try {
      const result = await agent.run({
        dir,
        system: SUMMARY_SYSTEM,
        prompt: `Write in ${thread.request.language ?? 'English'}; code, versions and names stay as written.\n\n${factsOf(thread, results)}`,
        taskKind: COMPARE_SUMMARY_TASK,
        capabilities: [],
        ...SUMMARY_LIMITS,
      })
      return result.text.trim() || undefined
    } catch (error) {
      if (!agentProblem(error)) log(`slack compare: summary failed: ${messageOf(error)}`)
      return undefined
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  const run = async (thread: CompareThread, runId: string, user: string) => {
    try {
      const results = await compareAll(comparableRows(thread.preview))
      const overview = await overviewOf(thread, results, user)
      const finished = await threads.update(thread.channel, thread.threadTs, (current) =>
        current?.status === 'running' && current.runId === runId
          ? {
              ...current,
              status: 'done',
              results,
              ...(overview && { summary: overview }),
            }
          : undefined,
      )
      if (!finished) return
      await reply(
        thread.channel,
        thread.threadTs,
        summaryMessage({
          request: thread.request,
          preview: thread.preview,
          results,
          ...(overview && { overview }),
        }),
      )
    } catch (error) {
      log(`slack compare: run in ${thread.channel}/${thread.threadTs} failed: ${messageOf(error)}`)
      const failed = await threads
        .update(thread.channel, thread.threadTs, (current) =>
          current?.runId === runId ? { ...current, status: 'failed' } : undefined,
        )
        .catch(() => undefined)
      if (failed)
        await say(
          thread.channel,
          thread.threadTs,
          'The comparison failed. Mention me to try again.',
        )
    }
  }

  const stale = (thread: CompareThread) =>
    thread.status === 'running' &&
    (!thread.runningSince ||
      deps.now().getTime() - Date.parse(thread.runningSince) > COMPARE_RUN_STALE_MS)

  const start = async (thread: CompareThread, user: string) => {
    if (comparableRows(thread.preview).length === 0) {
      await say(
        thread.channel,
        thread.threadTs,
        'Nothing can be compared yet. Correct the request first.',
      )
      return
    }
    const runId = randomUUID()
    const started = await threads.update(thread.channel, thread.threadTs, (current) =>
      current &&
      (current.status === 'pending' ||
        current.status === 'cancelled' ||
        current.status === 'failed' ||
        stale(current))
        ? {
            ...current,
            status: 'running',
            runId,
            runningSince: deps.now().toISOString(),
          }
        : undefined,
    )
    if (!started) return
    await reply(thread.channel, thread.threadTs, startedMessage(started.preview))
    const work = run(started, runId, user)
    if (deps.onBackground) deps.onBackground(work)
    else await work
  }

  const answer = async (thread: CompareThread, message: SlackCompareMessage) => {
    const repos = thread.preview.map((row) => row.repo)
    const target: RepoTarget =
      repos.length === 1 && repos[0]
        ? repoTarget(deps.config, repos[0])
        : {
            ...BOT_TARGET,
            teams: [...new Set(repos.flatMap((repo) => repoTarget(deps.config, repo).teams))],
          }
    let agent: Agent | undefined
    try {
      agent = await agentFor(message.user, 'Slack comparison question', target)
    } catch (error) {
      log(`slack compare: no agent for a question: ${messageOf(error)}`)
    }
    if (!agent) {
      await say(
        message.channel,
        thread.threadTs,
        'No AI provider is configured, so I cannot answer here.',
      )
      return
    }
    const question = message.text.replace(/<[@!][^>]*>/g, ' ').trim()
    const dir = await mkdtemp(join(tmpdir(), 'holtkeeper-compare-'))
    try {
      const result = await agent.run({
        dir,
        system: ANSWER_SYSTEM,
        prompt: [
          'Comparison:',
          factsOf(thread, thread.results ?? []),
          ...(thread.summary ? ['', 'Overview posted:', thread.summary] : []),
          ...(thread.turns.length > 0
            ? [
                '',
                'Earlier in the thread:',
                ...thread.turns.map((turn) => `${turn.role}: ${turn.text}`),
              ]
            : []),
          '',
          'Question:',
          question,
        ].join('\n'),
        taskKind: 'chat',
        capabilities: [],
        ...CHAT_REPLY_LIMITS,
      })
      const text = result.text.trim() || 'I have no answer to that.'
      await say(message.channel, thread.threadTs, text)
      await threads.update(thread.channel, thread.threadTs, (current) =>
        current
          ? {
              ...current,
              turns: [
                ...current.turns,
                { role: 'person' as const, text: question },
                { role: 'bot' as const, text },
              ].slice(-KEPT_TURNS),
            }
          : undefined,
      )
    } catch (error) {
      const problem = agentProblem(error)
      if (!problem)
        log(
          `slack compare: answering in ${message.channel}/${thread.threadTs} failed: ${messageOf(error)}`,
        )
      await say(
        message.channel,
        thread.threadTs,
        problem ?? 'I could not answer. Try again in a moment.',
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  const replyIn = async (thread: CompareThread, message: SlackCompareMessage) => {
    if (thread.status === 'running' && !stale(thread)) {
      await say(message.channel, thread.threadTs, 'Still comparing. I will post the summary here.')
      return
    }
    if (thread.status === 'done') {
      await answer(thread, message)
      return
    }
    await understand(message, thread.threadTs, thread)
  }

  const guarded = async (what: string, work: () => Promise<void>) => {
    try {
      await work()
    } catch (error) {
      log(`slack compare: ${what}: ${messageOf(error)}`)
    }
  }

  return {
    handleMention: (message) =>
      guarded('mention', async () => {
        if (!(await threads.claimMessage(message.channel, message.ts))) return
        const threadTs = message.threadTs ?? message.ts
        const thread = await threads.get(message.channel, threadTs)
        if (thread) await replyIn(thread, message)
        else await understand(message, threadTs, undefined)
      }),
    handleAction: (input) =>
      guarded('button', async () => {
        const thread = await threads.get(input.channel, input.threadTs)
        if (!thread) return
        if (input.action === 'confirm') await start(thread, input.user)
        else await cancel(thread)
      }),
  }
}
