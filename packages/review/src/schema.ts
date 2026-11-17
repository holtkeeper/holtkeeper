import { z } from 'zod'

/** Severity of a review finding, lowest first. */
export const severities = ['info', 'minor', 'major', 'critical'] as const
export type ReviewSeverity = (typeof severities)[number]

/** What a finding is about. */
export const categories = [
  'bug',
  'security',
  'performance',
  'maintainability',
  'tests',
  'style',
  'docs',
] as const
export type ReviewCategory = (typeof categories)[number]

/** `full` reviews the whole MR diff, `incremental` only what changed since the last reviewed head. */
export type ReviewMode = 'full' | 'incremental'

const suggestionSchema = z.object({
  replacement: z.string(),
  /** The lines the suggestion replaces, as they were at `head`; lets reports render a diff. */
  original: z.string().optional(),
})

/** Code a finding rests on: a file of the checkout, a line in it and what it shows. */
export const evidenceSchema = z.object({
  path: z.string(),
  line: z.number().int().positive().optional(),
  note: z.string().optional(),
})

export type Evidence = z.infer<typeof evidenceSchema>

const findingSchema = z.object({
  /** Stable for the same problem at the same place across runs. */
  id: z.string(),
  path: z.string(),
  line: z.number().int().positive(),
  startLine: z.number().int().positive().optional(),
  severity: z.enum(severities),
  category: z.enum(categories),
  title: z.string(),
  body: z.string(),
  /** `agent` or the quality check that found it, e.g. `gitleaks`, `testids`. */
  source: z.string(),
  suggestion: suggestionSchema.optional(),
  /** Code the agent read to back the finding; only paths that exist in the checkout are kept. */
  evidence: z.array(evidenceSchema).optional(),
  /** Whether the forge accepted it; `false` with `error` when it rejected the comment. */
  posted: z.boolean(),
  error: z.string().optional(),
  href: z.url({ protocol: /^https?$/ }).optional(),
})

const threadSchema = z.object({
  discussionId: z.string(),
  action: z.enum(['resolved', 'replied', 'kept']),
  path: z.string().optional(),
  line: z.number().optional(),
  reason: z.string(),
})

const skippedSchema = z.object({
  path: z.string(),
  reason: z.enum(['ignored', 'binary', 'collapsed', 'deleted', 'unchanged', 'too-large']),
})

const walkthroughSchema = z.array(
  z.object({
    /** Files of one logical change, as new-side paths. */
    files: z.array(z.string()),
    /** What changed there and why, in one or two sentences. */
    change: z.string(),
  }),
)

/** How hard the change is for a human to review: 1 trivial … 5 needs a long careful look. */
const effortSchema = z.number().int().min(1).max(5)

/** How long a careful human review of the whole merge request takes, by `estimateReviewMinutes`. */
export const reviewSizeLevels = ['ok', 'large', 'too-large'] as const

/** One merge request a too-large one could be split into, in merge order. */
const sizePartSchema = z.object({
  title: z.string(),
  /** New-side paths of the merge request that belong to this part. */
  files: z.array(z.string()),
})

/**
 * The estimated human review time of the whole merge request (ignored paths such as lockfiles and
 * generated code left out) and, when the summary note carries it, the advice to split.
 */
const reviewSizeSchema = z.object({
  minutes: z.number().int().nonnegative(),
  level: z.enum(reviewSizeLevels),
  /** Files and added plus removed lines the estimate counted. */
  files: z.number().int().nonnegative(),
  lines: z.number().int().nonnegative(),
  /** Logical changes (walkthrough entries) the estimate counted. */
  groups: z.number().int().nonnegative(),
  /** The review time model that made `minutes` (`ReviewTimeModel`); absent in older records. */
  model: z.string().optional(),
  /**
   * The agent's own estimate for the whole merge request, before the `agent` model bounds it;
   * absent when the agent gave none.
   */
  agentMinutes: z.number().int().positive().optional(),
  /** Present when this run's note advises splitting; texts are in the review language. */
  advice: z
    .object({
      texts: z.object({
        /** The estimated time, as a sentence. */
        estimate: z.string(),
        /** Only for `too-large`: a person cannot review this thoroughly in one sitting. */
        limit: z.string().optional(),
        /** The advice to split. */
        split: z.string(),
        /** Heading of the proposed parts; only in records from before `direction`. */
        parts: z.string().optional(),
        /** The note for authors whose code an AI agent writes. */
        ai: z.string(),
      }),
      /** `false` when splitting would not make the review easier (`reason` says why). */
      splittable: z.boolean(),
      reason: z.string().optional(),
      /** One to three sentences on how to split it by functionality, without file paths. */
      direction: z.string().optional(),
      /** Proposed parts with their files; only in records from before `direction`. */
      parts: z.array(sizePartSchema).optional(),
    })
    .optional(),
})

/** What one review run did; stored as the `review` analysis with `ref` `!<iid>`. */
export const reviewDataSchema = z.object({
  mergeRequest: z.object({
    id: z.number().int(),
    title: z.string(),
    webUrl: z.url({ protocol: /^https?$/ }),
    sourceBranch: z.string(),
    targetBranch: z.string(),
    author: z.string(),
  }),
  /** Head commit that was reviewed. */
  head: z.string(),
  /** Head of the earlier review an incremental run started from. */
  previousHead: z.string().optional(),
  /** `reply` runs answered one thread; `skipped` runs reviewed nothing (diff too large, nothing in scope). */
  mode: z.enum(['full', 'incremental', 'reply', 'skipped']),
  verdict: z.enum(['looks-good', 'needs-changes', 'skipped']),
  summary: z.string(),
  /** The agent's tour of the change, grouped by logical change. */
  walkthrough: walkthroughSchema.optional(),
  effort: effortSchema.optional(),
  /** Estimated human review time of the whole merge request; absent when the advice is off. */
  size: reviewSizeSchema.optional(),
  comments: z.array(findingSchema),
  threads: z.array(threadSchema),
  skipped: z.array(skippedSchema),
  stats: z.object({
    files: z.number().int(),
    changedLines: z.number().int(),
    /** Findings left out: below `minSeverity`, over `maxComments`, duplicates or invalid lines. */
    dropped: z.object({
      belowSeverity: z.number().int(),
      overLimit: z.number().int(),
      duplicates: z.number().int(),
      invalid: z.number().int(),
      /** Agent findings the verification pass showed wrong; absent in records before it. */
      refuted: z.number().int().optional(),
    }),
  }),
  /**
   * Agent findings the verification pass dropped, with the reason it gave; absent when it dropped
   * none or did not run.
   */
  refuted: z
    .array(
      z.object({
        path: z.string(),
        line: z.number().int(),
        severity: z.enum(severities),
        title: z.string(),
        reason: z.string(),
      }),
    )
    .optional(),
  approved: z.boolean(),
  checks: z.array(z.object({ name: z.string(), ok: z.boolean(), error: z.string().optional() })),
  usage: z
    .object({
      turns: z.number(),
      costUsd: z.number().optional(),
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
      /** Provider id of the model the review's main agent run used. */
      model: z.string().optional(),
    })
    .optional(),
  /** Guide scopes whose rules reached the agent, broad to narrow, e.g. `all`, `team:web`. */
  guideScopes: z.array(z.string()).optional(),
  /** `reviewPromptVersion()` of the run that asked the agent; absent without an agent review. */
  promptVersion: z.string().optional(),
  /** Wall time of the run, posting included. */
  durationMs: z.number().int().nonnegative().optional(),
})

export type ReviewData = z.infer<typeof reviewDataSchema>
export type ReviewFinding = z.infer<typeof findingSchema>
export type ThreadAction = z.infer<typeof threadSchema>
export type SkippedFile = z.infer<typeof skippedSchema>
export type ReviewUsage = NonNullable<ReviewData['usage']>
export type ReviewWalkthrough = NonNullable<ReviewData['walkthrough']>
export type ReviewSize = NonNullable<ReviewData['size']>
export type ReviewSizeLevel = ReviewSize['level']
export type ReviewSizeAdvice = NonNullable<ReviewSize['advice']>

/** The answer the review agent must give. */
export const agentReviewSchema = z.object({
  comments: z.array(
    z.object({
      path: z.string(),
      line: z.number().int(),
      startLine: z.number().int().optional(),
      severity: z.enum(severities),
      category: z.enum(categories),
      title: z.string(),
      body: z.string(),
      suggestion: z.object({ replacement: z.string() }).optional(),
      /** Code read to back the claim, above all code outside the diff it depends on. */
      evidence: z.array(evidenceSchema).optional(),
    }),
  ),
  summary: z.string(),
  walkthrough: walkthroughSchema.optional(),
  effort: effortSchema.optional(),
  /** Minutes a careful human review of the diff in this pass takes, by the agent. */
  reviewMinutes: z.number().int().min(1).max(1440).optional(),
  verdict: z.enum(['looks-good', 'needs-changes']),
  /**
   * Cross-part pass only: findings of the parts that report the same problem as another one, by
   * their numbers in the prompt; `id` is dropped in favor of `of`.
   */
  duplicates: z.array(z.object({ id: z.number().int(), of: z.number().int() })).optional(),
})

export type AgentReview = z.infer<typeof agentReviewSchema>
export type AgentComment = AgentReview['comments'][number]
