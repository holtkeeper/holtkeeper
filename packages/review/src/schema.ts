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
  /** `agent` or the quality check that found it, e.g. `oxlint`, `gitleaks`. */
  source: z.string(),
  suggestion: suggestionSchema.optional(),
  /** Whether the forge accepted it; `false` with `error` when it rejected the comment. */
  posted: z.boolean(),
  error: z.string().optional(),
  href: z.string().optional(),
})

const threadSchema = z.object({
  discussionId: z.string(),
  action: z.enum(['resolved', 'replied', 'kept']),
  path: z.string().optional(),
  line: z.number().optional(),
  reason: z.string(),
  /** The knowledge entry proposed from the author's reply, or why proposing it failed. */
  learning: z
    .union([
      z.object({ id: z.string(), status: z.string(), duplicateOf: z.string().optional() }),
      z.object({ error: z.string() }),
    ])
    .optional(),
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

/** What one review run did; stored as the `review` analysis with `ref` `!<iid>`. */
export const reviewDataSchema = z.object({
  mergeRequest: z.object({
    id: z.number().int(),
    title: z.string(),
    webUrl: z.string(),
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
    }),
  }),
  approved: z.boolean(),
  checks: z.array(z.object({ name: z.string(), ok: z.boolean(), error: z.string().optional() })),
  usage: z
    .object({
      turns: z.number(),
      costUsd: z.number().optional(),
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
    })
    .optional(),
})

export type ReviewData = z.infer<typeof reviewDataSchema>
export type ReviewFinding = z.infer<typeof findingSchema>
export type ThreadAction = z.infer<typeof threadSchema>
export type SkippedFile = z.infer<typeof skippedSchema>
export type ReviewUsage = NonNullable<ReviewData['usage']>
export type ReviewWalkthrough = NonNullable<ReviewData['walkthrough']>

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
    }),
  ),
  summary: z.string(),
  walkthrough: walkthroughSchema.optional(),
  effort: effortSchema.optional(),
  verdict: z.enum(['looks-good', 'needs-changes']),
})

export type AgentReview = z.infer<typeof agentReviewSchema>
export type AgentComment = AgentReview['comments'][number]
