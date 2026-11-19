import type { Toolset } from '@holtkeeper/agent'
import { type KnowledgeAccess, knowledgeTools } from '@holtkeeper/agent-tools'
import { type AnalyzerContext, defineAnalyzer } from '@holtkeeper/analyzer'
import type { GitForge, RepoRef } from '@holtkeeper/forge'
import { type IssueTracker, issueDetails } from '@holtkeeper/issues'
import {
  type MessageStore,
  agentTranslator,
  detectLocale,
  normalizeLocale,
  resolveMessages,
} from '@holtkeeper/messages'
import type { QualityCheck } from '@holtkeeper/quality'
import type { RepoRuleFile } from '@holtkeeper/rules'
import { z } from 'zod'

import { reviewAnalysis } from './analysis.ts'
import { type ReviewCheckName, reviewCheckNames } from './checks.ts'
import { DEFAULT_DEEP_FROM_MINUTES, DEFAULT_REVIEW_DEPTH, reviewDepths } from './depth.ts'
import { GO_GUIDELINES_TAG, type GoGuidelineSet } from './go-guidelines/schema.ts'
import { bundledGoGuidelines } from './go-guidelines/snapshot.ts'
import { readCheckoutRules } from './guidelines.ts'
import type { MediaReviewer } from './media.ts'
import { type ReviewMessages, englishReviewMessages, reviewMessageCatalog } from './messages.ts'
import { withPhase } from './phase.ts'
import {
  DEFAULT_REVIEW_COST_LIMIT_USD,
  type ReviewGuide,
  type ReviewOptions,
  type ReviewSteps,
  previousReview,
  requireReviewForge,
  reviewMergeRequest,
  reviewRef,
} from './pipeline.ts'
import { type ReviewStage, startProgress } from './progress.ts'
import { type ReplyOutcome, answerReplies, pendingReplies } from './replies.ts'
import { type ReviewData, type ReviewUsage, type ThreadAction, severities } from './schema.ts'
import { DEFAULT_IGNORE } from './scope.ts'
import {
  DEFAULT_REVIEW_TIME_MODEL,
  DEFAULT_SIZE_THRESHOLDS,
  reviewTimeModelInfo,
  reviewTimeModels,
} from './size.ts'
import { DEFAULT_RELEASE_BRANCHES, skipReason, skippedReview } from './skip.ts'

const flag = z.preprocess(
  (value) => (value === 'true' ? true : value === 'false' ? false : value),
  z.boolean(),
)

const list = <T extends z.ZodType>(item: T) =>
  z.preprocess(
    (value) =>
      typeof value === 'string'
        ? value
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : value,
    z.array(item),
  )

/** Options of the `review` analyzer. */
export const reviewOptionsSchema = z.object({
  mergeRequest: z.coerce.number().int().positive(),
  mode: z.enum(['auto', 'full', 'incremental']).default('auto'),
  maxComments: z.coerce.number().int().min(0).default(15),
  minSeverity: z.enum(severities).default('minor'),
  includeChecks: z.union([flag, list(z.enum(reviewCheckNames))]).default(['testids']),
  approve: z.enum(['never', 'when-clean']).default('never'),
  resolveSummary: z.enum(['when-clean', 'always', 'never']).default('when-clean'),
  depth: z
    .enum(reviewDepths)
    .default(DEFAULT_REVIEW_DEPTH)
    .describe(
      'Model of the review: standard (Sonnet), deep (Opus), or auto (default): Opus when the estimated review time of the reviewed changes reaches deepFromMinutes, Sonnet otherwise.',
    ),
  deepFromMinutes: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_DEEP_FROM_MINUTES)
    .describe('Estimated review minutes from which depth auto reviews with Opus (default 60).'),
  verify: flag
    .default(true)
    .describe(
      'A second agent pass tries to disprove each finding by reading the code (Opus for major and critical, else the review model) and drops the ones the code contradicts.',
    ),
  costLimitUsd: z.coerce
    .number()
    .min(0)
    .default(DEFAULT_REVIEW_COST_LIMIT_USD)
    .describe(
      'Soft spend limit of one review in USD: a pass that reaches its share stops reading and posts what it found. 0 turns it off.',
    ),
  showCost: flag
    .default(true)
    .describe('How long the review took and what it cost, as a last line of the summary note.'),
  impact: flag
    .default(true)
    .describe(
      'Computed callers, readers and writers and tests of the changed declarations in the review prompt.',
    ),
  ignore: list(z.string().min(1)).default([...DEFAULT_IGNORE]),
  maxDiffLines: z.coerce.number().int().positive().default(3000),
  language: z.string().min(1).optional(),
  instructions: z.string().optional(),
  replies: flag.default(false),
  media: flag.default(true),
  releaseBranches: list(z.string().regex(/^[^:]+:[^:]+$/)).default([...DEFAULT_RELEASE_BRANCHES]),
  reviewOwn: flag.default(false),
  force: flag.default(false),
  progressNote: z
    .enum(['first', 'always', 'never'])
    .default('first')
    .describe(
      'Note saying the review is running, removed when it ends: first (default) only before the first review of a merge request, always before every review, never.',
    ),
  goGuidelines: z
    .object({
      enabled: flag.default(true),
      tag: z.string().regex(GO_GUIDELINES_TAG).optional(),
    })
    .default({ enabled: true })
    .describe(
      'Modern Go guidelines (JetBrains/go-modern-guidelines) for merge requests changing Go modules: enabled (default true) and an optional release tag to pin, e.g. v0.1.1.',
    ),
  sizeAdvice: z
    .object({
      enabled: flag.default(true),
      largeMinutes: z.coerce
        .number()
        .int()
        .positive()
        .default(DEFAULT_SIZE_THRESHOLDS.largeMinutes),
      tooLargeMinutes: z.coerce
        .number()
        .int()
        .positive()
        .default(DEFAULT_SIZE_THRESHOLDS.tooLargeMinutes),
      model: z
        .enum(reviewTimeModels)
        .default(DEFAULT_REVIEW_TIME_MODEL)
        .meta({
          'x-labels': Object.fromEntries(
            reviewTimeModels.map((id) => [id, reviewTimeModelInfo[id].label]),
          ),
        })
        .describe(
          `How the review time is estimated. ${reviewTimeModels
            .map((id) => {
              const info = reviewTimeModelInfo[id]
              return `${info.label}: ${info.summary} Source: ${info.source}.`
            })
            .join(' ')}`,
        ),
    })
    .default({ enabled: true, ...DEFAULT_SIZE_THRESHOLDS, model: DEFAULT_REVIEW_TIME_MODEL })
    .describe(
      'Estimated human review time in the summary, by the chosen model; from largeMinutes (default 60) the summary advises splitting the merge request by functionality, from tooLargeMinutes (default 120) it says a person cannot review it thoroughly.',
    ),
})

/** What the host provides besides the analyzer context. All optional. */
export interface ReviewAnalyzerDeps {
  /** Quality checks `includeChecks` may run, by name. */
  checks?: Partial<Record<ReviewCheckName, QualityCheck>>
  /**
   * The checks for one repository, e.g. built with its settings; wins over `checks`. A failure
   * falls back to `checks`.
   */
  checksFor?: (repo: RepoRef) => Promise<Partial<Record<ReviewCheckName, QualityCheck>>>
  /** Whether the repository is meant to have tests (`repo.tests`); without it, always. */
  testsExpected?: (repo: RepoRef) => Promise<boolean>
  /**
   * The rules of a review or thread reply, from the repository's rules files (read from the
   * checkout) and the merge request's changed files (absent for thread replies: every file-scoped
   * rule may apply); they become the agent's stable context, and their sources are stored with the
   * review as `ruleSources`. Without it the review follows the rules files alone.
   */
  guideFor?: (
    repo: RepoRef,
    request: { repoFiles: readonly RepoRuleFile[]; files?: readonly string[] },
  ) => Promise<ReviewGuide | undefined>
  /**
   * Rules and learnings for the agent to search and propose to: the `knowledge` toolset is
   * mounted. `teamsOf` gives the repository's owner teams.
   */
  knowledge?: { access: KnowledgeAccess; teamsOf?: (repo: RepoRef) => string[] }
  /**
   * Review-specific agent tool sets; default: the `knowledge` toolset when configured. The host
   * attaches the shared code tools to every agent itself.
   */
  toolsetsFor?: (context: { repo: RepoRef; dir: string }) => readonly Toolset[]
  /**
   * The public API changes a merge request makes, computed from its base commit and the head
   * checkout without storing anything (see `ReviewRun.apiChanges`); without it the prompt has no
   * such section.
   */
  apiChangesFor?: (
    repo: RepoRef,
    context: { dir: string; baseSha: string; files: readonly string[]; signal?: AbortSignal },
  ) => Promise<string | undefined>
  /**
   * The issue tracker of a repository, whose `issue` gives reviews the tickets a merge request
   * names; without it, or without a tracker for the repository, reviews get no ticket context.
   */
  issueTrackerFor?: (repo: RepoRef) => Promise<IssueTracker | undefined>
  mediaReviewer?: MediaReviewer
  /**
   * The modern Go guidelines, for an optional pinned tag (falling back to another set when that
   * tag is not available). Default: the bundled snapshot.
   */
  goGuidelines?: (tag?: string) => Promise<GoGuidelineSet>
  /**
   * Username Holtkeeper posts as, or a function giving it per repository (forges differ);
   * markers in note bodies identify our notes either way.
   */
  botUsername?: string | ((repo: RepoRef) => string | undefined)
  /**
   * Translations of the review's fixed texts (`reviewMessageCatalog`). Without it every note is in
   * English; with it notes use the review language, and missing or outdated translations are made
   * with the run's agent when the store's settings allow it.
   */
  messages?: MessageStore
  steps?: Partial<ReviewSteps>
}

/**
 * The language of a review's fixed texts as a base language code: `language` when it names one,
 * else the language of the merge request description (the language the agent writes in), else
 * English.
 */
export function reviewLocale(language: string | undefined, description: string): string {
  return normalizeLocale(language) ?? detectLocale(description) ?? 'en'
}

const sum = (a: number | undefined, b: number | undefined) =>
  a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0)

/** `data` with the usage of runs outside the pipeline (text translations) added. */
const addUsage = (data: ReviewData, extra: ReviewUsage): ReviewData => {
  if (!extra.turns) return data
  const base = data.usage ?? { turns: 0 }
  const costUsd = sum(base.costUsd, extra.costUsd)
  const inputTokens = sum(base.inputTokens, extra.inputTokens)
  const outputTokens = sum(base.outputTokens, extra.outputTokens)
  return {
    ...data,
    usage: {
      ...base,
      turns: base.turns + extra.turns,
      ...(costUsd !== undefined && { costUsd }),
      ...(inputTokens !== undefined && { inputTokens }),
      ...(outputTokens !== undefined && { outputTokens }),
    },
  }
}

async function headCheckout(context: AnalyzerContext<ReviewOptions>, headSha: string) {
  const dir = context.dir
  if (dir) {
    const current = await context.runner.run(['git', 'rev-parse', 'HEAD'], { cwd: dir })
    if (current.exitCode === 0 && current.stdout.trim() === headSha) return dir
  }
  if (!context.checkout) return dir
  context.log?.(`checking out the merge request head ${headSha.slice(0, 8)}`)
  return (await context.checkout(context.repo, { ref: headSha })).dir
}

/** The review's fixed texts in the review language; translating runs on the job's agent and `usage` collects its cost. */
async function reviewTexts(
  context: AnalyzerContext<ReviewOptions>,
  deps: ReviewAnalyzerDeps,
  mr: { description: string },
) {
  const { options } = context
  const usage: ReviewUsage = { turns: 0 }
  const messages: ReviewMessages = deps.messages
    ? await resolveMessages({
        catalog: reviewMessageCatalog,
        locale: reviewLocale(options.language, mr.description),
        store: deps.messages,
        ...(context.agent && {
          translator: agentTranslator({
            agent: context.agent,
            ...(context.signal && { signal: context.signal }),
            track: (result) => {
              usage.turns += result.turns
              if (result.costUsd !== undefined)
                usage.costUsd = (usage.costUsd ?? 0) + result.costUsd
              if (result.usage) {
                usage.inputTokens = (usage.inputTokens ?? 0) + result.usage.inputTokens
                usage.outputTokens = (usage.outputTokens ?? 0) + result.usage.outputTokens
              }
            },
          }),
        }),
        ...(context.log && { log: context.log }),
      })
    : englishReviewMessages
  return { messages, usage }
}

/**
 * The review's fixed texts in the review language and, unless `progressNote` rules it out, the
 * posted "review is running" note. Translating runs on the job's agent; `usage` collects its cost.
 */
async function startTexts(
  context: AnalyzerContext<ReviewOptions & { progressNote?: 'first' | 'always' | 'never' }>,
  deps: ReviewAnalyzerDeps,
  forge: GitForge,
  mr: { id: number; description: string },
  botUsername: string | undefined,
) {
  const { options, repo } = context
  const { messages, usage } = await reviewTexts(context, deps, mr)
  const policy = options.progressNote ?? 'first'
  const first =
    policy !== 'first' ||
    !context.history ||
    !(await previousReview(context.history.analyses, repo, mr.id).catch(() => undefined))
  const owner = (await forge.getCurrentUser?.().catch(() => undefined))?.username ?? botUsername
  const progress =
    policy !== 'never' && first
      ? await startProgress({
          forge,
          repo: repo.path,
          mergeRequest: mr.id,
          messages,
          verify: options.verify !== false,
          ...(owner && { owner }),
          ...(context.log && { log: context.log }),
        })
      : undefined
  return { messages, usage, progress }
}

/** One line on what a replies run did, for the stored record. */
function repliesSummary(outcomes: readonly ReplyOutcome[]): string {
  if (outcomes.length === 0) return 'No replies waiting for an answer.'
  const count = (test: (outcome: ReplyOutcome) => boolean) => outcomes.filter(test).length
  const parts = [
    [count((o) => o.replied), 'answered'],
    [count((o) => o.resolved), 'resolved'],
    [count((o) => o.action === 'ack'), 'needed no answer'],
    [count((o) => o.action === 'skipped'), 'skipped'],
  ] as const
  return `Replies in ${outcomes.length} ${outcomes.length === 1 ? 'thread' : 'threads'}: ${parts
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} ${label}`)
    .join(', ')}.`
}

/**
 * The `review` analyzer: an AI review of one merge request, stored under `ref` `!<iid>`. With
 * `replies` it answers the replies people left in its threads instead (`answerReplies`), checking
 * out the head only when a reply needs the code. Review jobs should set `ref` to the head sha so
 * the checkout already sits at the reviewed commit.
 */
export function createReviewAnalyzer(deps: ReviewAnalyzerDeps = {}) {
  return defineAnalyzer<ReviewData, ReviewOptions>({
    kind: 'review',
    analysis: reviewAnalysis,
    scope: 'repo',
    needs: { checkout: true, forge: true, agent: 'optional', history: true },
    interactive: true,
    options: reviewOptionsSchema,
    flags: [
      { flag: 'mr', option: 'mergeRequest', description: 'merge request number (required)' },
      { flag: 'mode', option: 'mode', description: 'auto, full or incremental (default auto)' },
      {
        flag: 'max-comments',
        option: 'maxComments',
        description: 'most inline comments (default 15)',
      },
      {
        flag: 'min-severity',
        option: 'minSeverity',
        description: 'info, minor, major or critical (default minor)',
      },
      {
        flag: 'checks',
        option: 'includeChecks',
        description: 'true or a list: secrets,testids',
      },
      { flag: 'approve', option: 'approve', description: 'never or when-clean (default never)' },
      {
        flag: 'language',
        option: 'language',
        description: 'language of comments (default: the MR description)',
      },
    ],
    async run(context) {
      if (!context.forge) throw new Error('review needs a forge')
      const forge = requireReviewForge(context.forge)
      const { options, repo } = context
      const mr = await forge.getMergeRequest(repo.path, options.mergeRequest)
      const botUsername =
        typeof deps.botUsername === 'function' ? deps.botUsername(repo) : deps.botUsername
      const skip =
        options.replies || options.force
          ? undefined
          : skipReason(
              mr,
              {
                releaseBranches: options.releaseBranches ?? DEFAULT_RELEASE_BRANCHES,
                reviewOwn: options.reviewOwn ?? false,
              },
              botUsername,
            )
      if (skip) {
        context.log?.(`not reviewing: ${skip}`)
        return { data: skippedReview(mr, skip), ref: reviewRef(mr.id) }
      }
      // Posted before the checkout, which can take a while on large repositories.
      const texts = options.replies
        ? undefined
        : await startTexts(context, deps, forge, mr, botUsername)
      // A failed run must not leave the progress note saying the review is running.
      const workspaceAt = async () => {
        const dir = await headCheckout(context, mr.headSha)
        const knowledge = deps.knowledge
        const knowledgeRepo = { ...repo, teams: knowledge?.teamsOf?.(repo) ?? [] }
        const toolsets =
          dir && deps.toolsetsFor
            ? deps.toolsetsFor({ repo, dir })
            : knowledge
              ? [
                  knowledgeTools({
                    access: knowledge.access,
                    repo: knowledgeRepo,
                    taskKind: 'review',
                    actor: 'agent:review',
                  }),
                ]
              : undefined
        return { dir, toolsets }
      }
      const reviewOrReply = async () => {
        if (options.replies) {
          if (!context.agent) throw new Error('answering threads needs an agent')
          const started = performance.now()
          const usage: ReviewUsage = { turns: 0 }
          const pending = await pendingReplies({
            forge,
            repo,
            mr: mr.id,
            ...(botUsername ? { botUsername } : {}),
          })
          let ruleSources: string[] = []
          const outcomes = await answerReplies({
            forge,
            repo,
            mr: { id: mr.id, headSha: mr.headSha },
            pending,
            agent: withPhase(context.agent, 'reply'),
            workspace: async () => {
              const { dir, toolsets } = await workspaceAt()
              const guide = deps.guideFor
                ? await deps
                    .guideFor(repo, {
                      repoFiles: dir
                        ? await readCheckoutRules(context.runner, dir, context.signal)
                        : [],
                    })
                    .catch((error: unknown) => {
                      context.log?.(
                        `rules lookup failed: ${error instanceof Error ? error.message : String(error)}`,
                      )
                      return undefined
                    })
                : undefined
              if (guide?.text) ruleSources = guide.sources
              return {
                ...(dir ? { dir } : {}),
                ...(toolsets ? { toolsets } : {}),
                ...(guide?.text ? { context: guide.text } : {}),
              }
            },
            messages: async () => {
              const fixed = await reviewTexts(context, deps, mr)
              usage.turns += fixed.usage.turns
              if (fixed.usage.costUsd !== undefined)
                usage.costUsd = (usage.costUsd ?? 0) + fixed.usage.costUsd
              return fixed.messages
            },
            ...(botUsername ? { botUsername } : {}),
            ...(options.language ? { language: options.language } : {}),
            usage,
            ...(context.log ? { log: context.log } : {}),
            ...(context.signal ? { signal: context.signal } : {}),
          })
          const data: ReviewData = {
            mergeRequest: {
              id: mr.id,
              title: mr.title,
              webUrl: mr.webUrl,
              sourceBranch: mr.sourceBranch,
              targetBranch: mr.targetBranch,
              author: mr.author,
            },
            head: mr.headSha,
            mode: 'reply',
            verdict: 'skipped',
            summary: repliesSummary(outcomes),
            comments: [],
            threads: outcomes.flatMap((outcome): ThreadAction[] =>
              outcome.action === 'skipped'
                ? []
                : [
                    {
                      discussionId: outcome.discussionId,
                      ...(outcome.path !== undefined && { path: outcome.path }),
                      ...(outcome.line !== undefined && { line: outcome.line }),
                      action: outcome.resolved ? 'resolved' : outcome.replied ? 'replied' : 'kept',
                      reason: outcome.action,
                    },
                  ],
            ),
            skipped: [],
            stats: {
              files: 0,
              changedLines: 0,
              dropped: { belowSeverity: 0, overLimit: 0, duplicates: 0, invalid: 0 },
            },
            approved: false,
            checks: [],
            ...(usage.turns ? { usage } : {}),
            ...(ruleSources.length ? { ruleSources } : {}),
            durationMs: Math.round(performance.now() - started),
          }
          return { data, ref: reviewRef(mr.id) }
        }

        const { dir, toolsets } = await workspaceAt()
        const guideFor = deps.guideFor
        const checks = deps.checksFor
          ? await deps.checksFor(repo).catch((error: unknown) => {
              context.log?.(
                `checks setup failed: ${error instanceof Error ? error.message : String(error)}`,
              )
              return deps.checks
            })
          : deps.checks
        const tests = deps.testsExpected ? await deps.testsExpected(repo) : true
        const { apiChangesFor, issueTrackerFor } = deps
        const data = await reviewMergeRequest({
          repo,
          forge,
          ...(dir ? { dir } : {}),
          runner: context.runner,
          ...(context.agent ? { agent: context.agent } : {}),
          ...(context.history ? { analyses: context.history.analyses } : {}),
          options,
          ...(checks ? { checks } : {}),
          ...(guideFor
            ? { guide: (repoFiles, files) => guideFor(repo, { repoFiles, files }) }
            : {}),
          ...(toolsets ? { toolsets } : {}),
          ...(apiChangesFor ? { apiChanges: (request) => apiChangesFor(repo, request) } : {}),
          ...(issueTrackerFor && {
            tickets: async (keys) => issueDetails(await issueTrackerFor(repo), keys),
          }),
          ...(!tests && { tests: false as const }),
          ...(botUsername ? { botUsername } : {}),
          ...(deps.mediaReviewer ? { mediaReviewer: deps.mediaReviewer } : {}),
          goGuidelines: deps.goGuidelines ?? (() => bundledGoGuidelines()),
          ...(deps.steps ? { steps: deps.steps } : {}),
          ...(context.log ? { log: context.log } : {}),
          ...(context.signal ? { signal: context.signal } : {}),
          ...(texts && { messages: texts.messages }),
          ...(texts?.progress && {
            onProgress: (stage: ReviewStage) => texts.progress?.update(stage),
          }),
        })
        await texts?.progress?.finish()
        return { data: texts ? addUsage(data, texts.usage) : data, ref: reviewRef(mr.id) }
      }
      try {
        return await reviewOrReply()
      } catch (error) {
        await texts?.progress?.fail()
        throw error
      }
    },
  })
}

/** The `review` analyzer without checks, panel rules or learnings. */
export const reviewAnalyzer = createReviewAnalyzer()
