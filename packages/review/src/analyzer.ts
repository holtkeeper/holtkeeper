import type { Toolset } from '@holtkeeper/agent'
import { type KnowledgeAccess, knowledgeTools } from '@holtkeeper/agent-tools'
import { type AnalyzerContext, defineAnalyzer } from '@holtkeeper/analyzer'
import type { GitForge, RepoRef } from '@holtkeeper/forge'
import {
  type MessageStore,
  agentTranslator,
  detectLocale,
  normalizeLocale,
  resolveMessages,
} from '@holtkeeper/messages'
import type { QualityCheck } from '@holtkeeper/quality'
import { z } from 'zod'

import { reviewAnalysis } from './analysis.ts'
import { type ReviewCheckName, reviewCheckNames } from './checks.ts'
import { GO_GUIDELINES_TAG, type GoGuidelineSet } from './go-guidelines/schema.ts'
import { bundledGoGuidelines } from './go-guidelines/snapshot.ts'
import { type Guideline, readGuidelines } from './guidelines.ts'
import type { MediaReviewer } from './media.ts'
import { type ReviewMessages, englishReviewMessages, reviewMessageCatalog } from './messages.ts'
import {
  type ReviewGuide,
  type ReviewOptions,
  type ReviewSteps,
  previousReview,
  requireReviewForge,
  reviewMergeRequest,
  reviewRef,
} from './pipeline.ts'
import { startProgress } from './progress.ts'
import { type ReviewData, type ReviewUsage, severities } from './schema.ts'
import { DEFAULT_IGNORE } from './scope.ts'
import { DEFAULT_LINES_PER_HOUR, DEFAULT_SIZE_THRESHOLDS } from './size.ts'
import { DEFAULT_RELEASE_BRANCHES, skipReason, skippedReview } from './skip.ts'
import { replyToThread } from './thread.ts'

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
  depth: z.enum(['standard', 'deep']).default('standard'),
  ignore: list(z.string().min(1)).default([...DEFAULT_IGNORE]),
  maxDiffLines: z.coerce.number().int().positive().default(3000),
  language: z.string().min(1).optional(),
  instructions: z.string().optional(),
  replyTo: z.string().min(1).optional(),
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
      linesPerHour: z.coerce
        .number()
        .int()
        .min(50)
        .max(5000)
        .default(DEFAULT_LINES_PER_HOUR)
        .describe(
          `Weighted lines a careful reviewer reads in an hour (default ${DEFAULT_LINES_PER_HOUR}); lower makes estimates longer.`,
        ),
    })
    .default({ enabled: true, ...DEFAULT_SIZE_THRESHOLDS, linesPerHour: DEFAULT_LINES_PER_HOUR })
    .describe(
      `Estimated human review time in the summary at linesPerHour (default ${DEFAULT_LINES_PER_HOUR}); from largeMinutes (default 60) the summary advises splitting the merge request by functionality, from tooLargeMinutes (default 120) it says a person cannot review it thoroughly.`,
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
   * The repository's Guide for a review or thread reply, from its rules files (read from the
   * checkout), the text knowledge notes are ranked by and the merge request's changed files (absent
   * for thread replies: every note may apply); it becomes the agent's stable context. Scopes it
   * names are stored with the review as `guideScopes`.
   */
  guideFor?: (
    repo: RepoRef,
    request: { docs: readonly Guideline[]; query?: string; files?: readonly string[] },
  ) => Promise<ReviewGuide | undefined>
  /**
   * The team knowledge base: the `knowledge` toolset is mounted. `teamsOf` gives the repository's
   * owner teams.
   */
  knowledge?: { access: KnowledgeAccess; teamsOf?: (repo: RepoRef) => string[] }
  /**
   * Review-specific agent tool sets; default: the `knowledge` toolset when configured. The host
   * attaches the shared code tools to every agent itself.
   */
  toolsetsFor?: (context: { repo: RepoRef; dir: string }) => readonly Toolset[]
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
          ...(owner && { owner }),
          ...(context.log && { log: context.log }),
        })
      : undefined
  return { messages, usage, progress }
}

/**
 * The `review` analyzer: an AI review of one merge request, stored under `ref` `!<iid>`. With
 * `replyTo` it answers a reply in one of its threads instead. Jobs should set `ref` to the head sha
 * so the checkout already sits at the reviewed commit.
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
        options.replyTo || options.force
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
      const texts = options.replyTo
        ? undefined
        : await startTexts(context, deps, forge, mr, botUsername)
      // A failed run must not leave the progress note saying the review is running.
      const reviewOrReply = async () => {
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

        if (options.replyTo) {
          if (!context.agent) throw new Error('answering a thread needs an agent')
          const started = performance.now()
          const usage: ReviewUsage = { turns: 0 }
          const guide = deps.guideFor
            ? await deps
                .guideFor(repo, { docs: dir ? await readGuidelines(dir) : [], query: mr.title })
                .catch((error: unknown) => {
                  context.log?.(
                    `guide lookup failed: ${error instanceof Error ? error.message : String(error)}`,
                  )
                  return undefined
                })
            : undefined
          const reply = await replyToThread({
            forge,
            repo,
            mr: mr.id,
            discussion: options.replyTo,
            agent: context.agent,
            ...(dir ? { dir } : {}),
            ...(botUsername ? { botUsername } : {}),
            ...(options.language ? { language: options.language } : {}),
            ...(toolsets ? { toolsets } : {}),
            ...(guide?.text ? { context: guide.text } : {}),
            usage,
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
            summary: reply.replied
              ? `Answered thread ${reply.discussionId} (${reply.action}).`
              : `Did not answer: ${reply.reason ?? 'nothing to do'}.`,
            comments: [],
            threads: reply.replied
              ? [
                  {
                    discussionId: reply.discussionId,
                    action: reply.resolved ? 'resolved' : 'replied',
                    reason: reply.action,
                  },
                ]
              : [],
            skipped: [],
            stats: {
              files: 0,
              changedLines: 0,
              dropped: { belowSeverity: 0, overLimit: 0, duplicates: 0, invalid: 0 },
            },
            approved: false,
            checks: [],
            ...(usage.turns ? { usage } : {}),
            ...(guide?.text && guide.scopes.length ? { guideScopes: guide.scopes } : {}),
            durationMs: Math.round(performance.now() - started),
          }
          return { data, ref: reviewRef(mr.id) }
        }

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
            ? { guide: (docs, query, files) => guideFor(repo, { docs, query, files }) }
            : {}),
          ...(toolsets ? { toolsets } : {}),
          ...(!tests && { tests: false as const }),
          ...(botUsername ? { botUsername } : {}),
          ...(deps.mediaReviewer ? { mediaReviewer: deps.mediaReviewer } : {}),
          goGuidelines: deps.goGuidelines ?? (() => bundledGoGuidelines()),
          ...(deps.steps ? { steps: deps.steps } : {}),
          ...(context.log ? { log: context.log } : {}),
          ...(context.signal ? { signal: context.signal } : {}),
          ...(texts && { messages: texts.messages }),
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

/** The `review` analyzer without checks, a Guide or knowledge. */
export const reviewAnalyzer = createReviewAnalyzer()
