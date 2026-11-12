import type { Toolset } from '@holtkeeper/agent'
import { type KnowledgeAccess, knowledgeTools } from '@holtkeeper/agent-tools'
import { type AnalyzerContext, defineAnalyzer } from '@holtkeeper/analyzer'
import type { RepoRef } from '@holtkeeper/forge'
import type { QualityCheck } from '@holtkeeper/quality'
import { z } from 'zod'

import { reviewAnalysis } from './analysis.ts'
import { type ReviewCheckName, reviewCheckNames } from './checks.ts'
import { type Guideline, readGuidelines } from './guidelines.ts'
import type { MediaReviewer } from './media.ts'
import {
  type ReviewGuide,
  type ReviewOptions,
  type ReviewSteps,
  requireReviewForge,
  reviewMergeRequest,
  reviewRef,
} from './pipeline.ts'
import { type ReviewData, type ReviewUsage, severities } from './schema.ts'
import { DEFAULT_IGNORE } from './scope.ts'
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
   * checkout) and the text knowledge notes are ranked by; it becomes the agent's stable context.
   * Scopes it names are stored with the review as `guideScopes`.
   */
  guideFor?: (
    repo: RepoRef,
    request: { docs: readonly Guideline[]; query?: string },
  ) => Promise<ReviewGuide | undefined>
  /**
   * The team knowledge base: the `knowledge` toolset is mounted. `groupsOf` gives the repository's
   * config groups.
   */
  knowledge?: { access: KnowledgeAccess; groupsOf?: (repo: RepoRef) => string[] }
  /**
   * Review-specific agent tool sets; default: the `knowledge` toolset when configured. The host
   * attaches the shared code tools to every agent itself.
   */
  toolsetsFor?: (context: { repo: RepoRef; dir: string }) => readonly Toolset[]
  mediaReviewer?: MediaReviewer
  /**
   * Username Holtkeeper posts as, or a function giving it per repository (forges differ);
   * markers in note bodies identify our notes either way.
   */
  botUsername?: string | ((repo: RepoRef) => string | undefined)
  steps?: Partial<ReviewSteps>
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
      const dir = await headCheckout(context, mr.headSha)
      const knowledge = deps.knowledge
      const knowledgeRepo = { ...repo, groups: knowledge?.groupsOf?.(repo) ?? [] }
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
        ...(guideFor ? { guide: (docs, query) => guideFor(repo, { docs, query }) } : {}),
        ...(toolsets ? { toolsets } : {}),
        ...(!tests && { tests: false as const }),
        ...(botUsername ? { botUsername } : {}),
        ...(deps.mediaReviewer ? { mediaReviewer: deps.mediaReviewer } : {}),
        ...(deps.steps ? { steps: deps.steps } : {}),
        ...(context.log ? { log: context.log } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
      })
      return { data, ref: reviewRef(mr.id) }
    },
  })
}

/** The `review` analyzer without checks, a Guide or knowledge. */
export const reviewAnalyzer = createReviewAnalyzer()
